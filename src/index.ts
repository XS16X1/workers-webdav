/**
 * r2-webdav — WebDAV (Class 1 + Class 2) server for Cloudflare R2.
 *
 * Locks live in side objects under `.__webdav/locks/` so lock operations are
 * O(1) regardless of object size. Credentials come only from runtime
 * variables/secrets (defaults ship in wrangler.toml [vars]). Uploads stream
 * into R2; recursive operations run through a bounded concurrency gate.
 * Deploy: README (Deploy-to-Workers button / Git integration, auto-creates
 * the bucket from wrangler.toml).
 */

import { DOMParser } from '@xmldom/xmldom';

export interface Env {
	bucket: R2Bucket;
	USERNAME?: string;
	PASSWORD?: string;
	/** Cap on PROPFIND / directory-listing entries (0 = unlimited). */
	MAX_LIST_ENTRIES?: string;
}

/* Constants */

const DEAD_PROPERTY_PREFIX = 'dead_property:';
const INTERNAL_PREFIX = '.__webdav/';
const LOCK_OBJECT_PREFIX = `${INTERNAL_PREFIX}locks/`;
const LOCK_WRITE_RETRY_ATTEMPTS = 5;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_LOCK_TIMEOUT = 3600;
const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
const MAX_LIST_ENTRIES_DEFAULT = 10000;
const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];
const DAV_HEADERS = { Allow: SUPPORT_METHODS.join(', '), DAV: '1, 2', 'MS-Author-Via': 'DAV' };
const STATUS_TEXT: Record<number, string> = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	409: 'Conflict',
	412: 'Precondition Failed',
	415: 'Unsupported Media Type',
	423: 'Locked',
};
const CORS_ALLOW_HEADERS = 'authorization, content-type, depth, overwrite, destination, range, if, lock-token, timeout';
const CORS_EXPOSE_HEADERS =
	'content-type, content-length, dav, etag, last-modified, location, date, content-range, lock-token, ms-author-via';
const SUPPORTED_LOCK_XML =
	'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>' +
	'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>';
const HTML_PAGE_STYLE =
	"*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href=\"../\"]{background-color:#cbd5e1;}";

/* Types */

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

type DeadProperty = { namespaceURI: string; localName: string; prefix: string | null; valueXml: string };

type PropfindRequest = { mode: 'allprop' } | { mode: 'propname' } | { mode: 'prop'; properties: DeadProperty[] };

type ProppatchOperation = { action: 'set' | 'remove'; property: DeadProperty };

type IfTaggedList = { tag: string | null; conditions: IfCondition[] };

type IfCondition = { negated: boolean; kind: 'token' | 'etag'; value: string };

type IfEvaluation = { passed: boolean; tokens: string[] };

type Credentials = { username: string; password: string };

type LockTableEntry = { locks: LockDetails[]; etag: string | null };

type LockTable = Map<string, LockTableEntry>;

/* Small utilities */

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/** Uniform error/empty responses; 204 gets a null body as required by RFC. */
function fail(status: number, init?: { body?: string; headers?: HeadersInit }): Response {
	return new Response(status === 204 ? null : (init?.body ?? STATUS_TEXT[status] ?? ''), {
		status,
		headers: init?.headers,
	});
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

/** Run `fn` over items with at most `limit` in flight over one shared iterator. */
async function forEachConcurrent<T>(
	iterable: AsyncIterable<T> | Iterable<T>,
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let iterator: AsyncIterator<T>;
	if (Symbol.asyncIterator in Object(iterable)) {
		iterator = (iterable as AsyncIterable<T>)[Symbol.asyncIterator]();
	} else {
		const sync = (iterable as Iterable<T>)[Symbol.iterator]();
		iterator = {
			async next(): Promise<IteratorResult<T>> {
				const result = sync.next();
				return { done: result.done ?? false, value: result.value };
			},
		};
	}
	let done = false;
	const next = async (): Promise<IteratorResult<T>> => {
		if (done) {
			return { done: true, value: undefined as never };
		}
		try {
			const result = await iterator.next();
			if (result.done) {
				done = true;
			}
			return result;
		} catch (error) {
			done = true;
			throw error;
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, limit) }, async () => {
			for (;;) {
				let result: IteratorResult<T>;
				try {
					result = await next();
				} catch {
					done = true;
					return;
				}
				if (result.done) {
					return;
				}
				await fn(result.value);
			}
		}),
	);
}

/* Path helpers */

function getResourceHref(key: string, isCollection: boolean): string {
	if (key === '') {
		return '/';
	}
	let href = `/${key + (isCollection ? '/' : '')}`;
	return href
		.split('/')
		.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
		.join('/');
}

function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

function getParentPath(resourcePath: string): string {
	return resourcePath.replace(/\/$/, '').split('/').slice(0, -1).join('/');
}

/** Worker-internal objects (locks etc.) are never WebDAV-visible. */
function isInternalPath(resourcePath: string): boolean {
	return resourcePath === INTERNAL_PREFIX.slice(0, -1) || resourcePath.startsWith(INTERNAL_PREFIX);
}

function makeResourcePath(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

/** Only the collection marker is meaningful; anything else is ignored so a
 * tampered metadata value can never be injected into XML output. */
function sanitizeResourceType(value: string | undefined): string {
	return value === '<collection />' ? '<collection />' : '';
}

function isCollectionObject(object: R2Object | null | undefined): boolean {
	return object != null && sanitizeResourceType(object.customMetadata?.resourcetype) === '<collection />';
}

async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}
	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		return sanitizeResourceType(resource.customMetadata?.resourcetype) === '<collection />';
	}
	let descendants = await bucket.list({ prefix: `${resourcePath}/`, limit: 1 });
	return descendants.objects.length > 0;
}

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function ancestorChain(resourcePath: string): string[] {
	let chain: string[] = [];
	for (let current = resourcePath; current !== ''; current = getParentPath(current)) {
		chain.push(current);
	}
	return chain;
}

/* Listing / deletion */

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive = false) {
	let cursor: string | undefined;
	let truncated = true;
	while (truncated) {
		let page = await bucket.list({
			prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor,
			include: ['httpMetadata', 'customMetadata'],
		});
		truncated = page.truncated;
		cursor = page.truncated ? page.cursor : undefined;
		for (let object of page.objects) {
			if (!object.key.startsWith(INTERNAL_PREFIX)) {
				yield object;
			}
		}
	}
}

async function deleteByPrefix(bucket: R2Bucket, prefix: string | undefined): Promise<void> {
	let cursor: string | undefined;
	do {
		let page = await bucket.list({ prefix, cursor });
		let keys = page.objects.map((object) => object.key);
		for (let index = 0; index < keys.length; index += 1000) {
			await bucket.delete(keys.slice(index, index + 1000));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
}

/** Delete a file or whole subtree (lock checks already passed). Root wipes
 * everything — credentials live in env vars, never in the bucket. */
async function deleteResourceTree(bucket: R2Bucket, resourcePath: string): Promise<void> {
	if (resourcePath === '') {
		return deleteByPrefix(bucket, undefined);
	}
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return;
	}
	if (isCollectionObject(resource)) {
		await deleteByPrefix(bucket, `${resourcePath}/`);
	}
	await bucket.delete(resourcePath);
}

/* XML helpers */

function renderDavProperty(propName: string, value: string): string {
	return `<${propName}>${RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value)}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function parseDeadPropertyJson(value: string): DeadProperty | null {
	try {
		let parsed = JSON.parse(value) as DeadProperty;
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof parsed.namespaceURI === 'string' &&
			typeof parsed.localName === 'string'
		) {
			return parsed;
		}
	} catch {}
	return null;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	return value === undefined ? null : parseDeadPropertyJson(value);
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	return Object.entries(metadata ?? {})
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => parseDeadPropertyJson(value))
		.filter((property): property is DeadProperty => property !== null);
}

/** Render a dead property; `empty` yields the self-closing form (propname /
 * propstat listings). */
function renderPropertyElement(property: DeadProperty, empty = false): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let xmlns =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return empty ? `<${qualifiedName}${xmlns} />` : `<${qualifiedName}${xmlns}>${property.valueXml}</${qualifiedName}>`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && !element.namespaceURI) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	return errors.length > 0 ? null : document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let children = getChildElements(document.documentElement);
	if (children.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = children.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return { mode: 'prop', properties: properties as DeadProperty[] };
	}
	if (children.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

/* Lock storage (side objects under .__webdav/locks/, optimistic concurrency) */

function lockObjectKey(resourcePath: string): string {
	return `${LOCK_OBJECT_PREFIX}${encodeURIComponent(resourcePath)}`;
}

function parseLockRecordList(raw: string): LockDetails[] {
	try {
		let parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.flatMap((record) => {
			if (record && typeof record === 'object' && typeof (record as LockDetails).token === 'string') {
				let normalized = normalizeLockDetails(record as Partial<LockDetails> & Pick<LockDetails, 'token'>);
				return normalized === null ? [] : [normalized];
			}
			return [];
		});
	} catch {
		return [];
	}
}

async function readLockEntry(bucket: R2Bucket, resourcePath: string): Promise<LockTableEntry> {
	let object = await bucket.get(lockObjectKey(resourcePath));
	if (object === null) {
		return { locks: [], etag: null };
	}
	let text = await object.text();
	return { locks: parseLockRecordList(text), etag: object.etag };
}

/** Load every lock record in the bucket; one listing beats per-path lookups
 * when checking ancestor chains or whole subtrees. */
async function readLockTable(bucket: R2Bucket): Promise<LockTable> {
	let table: LockTable = new Map();
	let cursor: string | undefined;
	do {
		let page = await bucket.list({ prefix: LOCK_OBJECT_PREFIX, cursor });
		await forEachConcurrent(page.objects, DEFAULT_CONCURRENCY, async (object) => {
			let stored = await bucket.get(object.key);
			if (stored !== null) {
				let resourcePath = decodeURIComponent(object.key.slice(LOCK_OBJECT_PREFIX.length));
				table.set(resourcePath, { locks: parseLockRecordList(await stored.text()), etag: stored.etag });
			}
		});
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
	return table;
}

async function writeLocks(bucket: R2Bucket, resourcePath: string, locks: LockDetails[]): Promise<void> {
	let key = lockObjectKey(resourcePath);
	for (let attempt = 0; attempt < LOCK_WRITE_RETRY_ATTEMPTS; attempt++) {
		let current = await bucket.get(key);
		let created = await bucket.put(
			key,
			JSON.stringify(locks),
			current === null ? { onlyIf: { uploadedBefore: new Date() } } : { onlyIf: { etagMatches: current.etag } },
		);
		if (created !== null) {
			return;
		}
	}
	// Contention beyond the retry budget: converge on last writer.
	if ((await bucket.put(key, JSON.stringify(locks))) === null) {
		throw new Error('failed to persist lock records');
	}
}

function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}
	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: lockDetails.scope === 'shared' ? 'shared' : 'exclusive',
		depth: lockDetails.depth === 'infinity' ? 'infinity' : '0',
		timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

/** Active locks stored in an object's legacy metadata fields (pre-side-object
 * format), read for backward compatibility. */
function getLegacyLocks(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.['lock_records'];
	if (records !== undefined) {
		let parsed = parseLockRecordList(records);
		if (parsed.length > 0) {
			return parsed;
		}
	}
	let token = customMetadata?.lock_token;
	if (token === undefined) {
		return [];
	}
	let normalized = normalizeLockDetails({
		token,
		owner: customMetadata?.lock_owner,
		scope: customMetadata?.lock_scope === 'shared' ? 'shared' : 'exclusive',
		depth: customMetadata?.lock_depth === 'infinity' ? 'infinity' : '0',
		timeout: customMetadata?.lock_timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.lock_expires_at ?? 0),
		root: customMetadata?.lock_root ?? '/',
	});
	return normalized === null ? [] : [normalized];
}

async function getActiveLocks(bucket: R2Bucket, resourcePath: string, table?: LockTable): Promise<LockDetails[]> {
	let locks: LockDetails[] = table?.get(resourcePath)?.locks ?? (await readLockEntry(bucket, resourcePath)).locks;
	if (resourcePath !== '') {
		let resource = await bucket.head(resourcePath);
		locks.push(...getLegacyLocks(resource?.customMetadata));
	}
	return locks.filter((lock) => lock.expiresAt > Date.now());
}

function getLockDiscovery(lockDetails: LockDetails[]): string {
	return lockDetails
		.map(
			(lock) =>
				`<activelock><locktype><write /></locktype><lockscope><${lock.scope} /></lockscope><depth>${lock.depth}</depth>${lock.owner ? `<owner>${escapeXml(lock.owner)}</owner>` : ''}<timeout>${escapeXml(lock.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lock.token)}</href></locktoken><lockroot><href>${escapeXml(lock.root)}</href></lockroot></activelock>`,
		)
		.join('');
}

function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = { ...customMetadata };
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

function isProtectedProperty(property: DeadProperty): boolean {
	let local = property.localName;
	return LOCK_METADATA_KEYS.includes(local) || local === 'supportedlock' || local === 'lockdiscovery';
}

function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	let fallback = () => ({
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	});
	for (const item of (timeoutHeader ?? '').split(',').map((value) => value.trim())) {
		if (item.toLowerCase() === 'infinite') {
			return { timeout: 'Infinite', expiresAt: Date.now() + MAX_LOCK_TIMEOUT * 1000 };
		}
		let seconds = Number(item.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (Number.isFinite(seconds) && seconds > 0) {
			seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
			return { timeout: `Second-${seconds}`, expiresAt: Date.now() + seconds * 1000 };
		}
	}
	return timeoutHeader === null ? fallback() : fallback();
}

function extractLockOwner(body: string): string | undefined {
	let owner = body.match(/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i)?.[1]?.trim();
	return owner ? owner : undefined;
}

/* `If` header parsing (RFC 4918 §10.4): tagged lists, `Not`, nesting, tokens,
 * hrefs, etags. Malformed headers are ignored rather than rejected. */

function parseIfHeader(header: string): IfTaggedList[] | null {
	let position = 0;
	const spaces = () => {
		while (position < header.length && /\s/.test(header[position])) {
			position++;
		}
	};
	const peek = (): string | null => header[position] ?? null;
	// Parses one parenthesised group of conditions; nested groups flatten (AND).
	const conditions = (): IfCondition[] | null => {
		if (peek() !== '(') {
			return null;
		}
		position++;
		let out: IfCondition[] = [];
		for (;;) {
			spaces();
			let current = peek();
			if (current === null) {
				return null;
			}
			if (current === ')') {
				position++;
				return out;
			}
			if (current === '(') {
				let nested = conditions();
				if (nested === null) {
					return null;
				}
				out.push(...nested);
				continue;
			}
			let negated = false;
			if (header.startsWith('Not', position) && !/[\w-]/.test(header[position + 3] ?? '')) {
				negated = true;
				position += 3;
				spaces();
				current = peek();
			}
			if (current !== '<' && current !== '[') {
				return null;
			}
			let close = current === '<' ? '>' : ']';
			let end = header.indexOf(close, position);
			if (end === -1) {
				return null;
			}
			let value = header.slice(position + 1, end);
			position = end + 1;
			out.push({ negated, kind: current === '<' ? 'token' : 'etag', value: current === '[' ? value.trim() : value });
		}
	};

	let lists: IfTaggedList[] = [];
	spaces();
	while (position < header.length) {
		spaces();
		if (position >= header.length) {
			break;
		}
		let tag: string | null = null;
		if (peek() === '[') {
			position++;
			let end = header.indexOf(']', position);
			if (end === -1) {
				return null;
			}
			tag = header.slice(position, end).trim();
			position = end + 1;
			spaces();
		}
		let group = conditions();
		if (group === null) {
			return null;
		}
		lists.push({ tag, conditions: group });
	}
	return lists;
}

function evaluateIfHeader(
	header: string | null,
	request: Request,
	activeTokens: Set<string>,
	currentEtag: string | null,
): IfEvaluation {
	if (!header?.trim()) {
		return { passed: true, tokens: [] };
	}
	let lists = parseIfHeader(header);
	if (lists === null) {
		console.warn('r2-webdav: ignoring malformed If header');
		return { passed: true, tokens: [] };
	}

	let tokens: string[] = [];
	let anyApplicable = false;
	let requestUrl = new URL(request.url).toString();

	for (let list of lists) {
		// Only lists tagged with the request target apply to it; untagged lists
		// always apply. No applicable list → header ignored (RFC 4918 §10.4.1).
		if (list.tag !== null) {
			let tagUrl: string;
			try {
				tagUrl = new URL(list.tag, requestUrl).toString();
			} catch {
				continue;
			}
			if (tagUrl !== requestUrl) {
				continue;
			}
		}
		anyApplicable = true;

		let allTrue = list.conditions.every((condition) => {
			let result: boolean;
			if (condition.kind === 'token') {
				let token = normalizeLockToken(condition.value);
				if (token === 'DAV:no-lock') {
					result = false;
				} else {
					if (!condition.negated) {
						tokens.push(token);
					}
					result = activeTokens.has(token);
				}
			} else {
				result = currentEtag !== null && condition.value === currentEtag;
			}
			return condition.negated ? !result : result;
		});
		if (allTrue) {
			return { passed: true, tokens: [...new Set(tokens)] };
		}
	}

	return { passed: !anyApplicable, tokens: [...new Set(tokens)] };
}

/** Lock tokens the client claims to hold (from If / Lock-Token headers). */
function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}
	for (const match of (request.headers.get('If') ?? '').matchAll(/<([^>]+)>/g)) {
		let token = normalizeLockToken(match[1]);
		if (token !== '' && token !== 'DAV:no-lock') {
			lockTokens.push(token);
		}
	}
	return [...new Set(lockTokens)];
}

/* Credentials — runtime variables / secrets only; nothing is generated or
 * stored in the bucket. Defaults ship in wrangler.toml [vars]. */

const FALLBACK_CREDENTIALS = { username: 'admin', password: 'admin' };

function resolveCredentials(env: Env): Credentials {
	let username = env.USERNAME?.trim();
	let password = env.PASSWORD?.trim();
	if (!username || !password) {
		console.warn(
			'r2-webdav: USERNAME/PASSWORD runtime variables are missing or blank; using built-in defaults. ' +
				'Set them under Settings → Variables and Secrets (or `wrangler secret put`).',
		);
		return { username: username || FALLBACK_CREDENTIALS.username, password: password || FALLBACK_CREDENTIALS.password };
	}
	return { username, password };
}

function isAuthorized(request: Request, credentials: Credentials): boolean {
	let encoder = new TextEncoder();
	return timingSafeEqual(
		encoder.encode(request.headers.get('Authorization') ?? ''),
		encoder.encode(`Basic ${btoa(`${credentials.username}:${credentials.password}`)}`),
	);
}

/* Property rendering */

function extractFilenameFromDisposition(disposition: string | undefined): string | undefined {
	let match = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
	if (!match) {
		return undefined;
	}
	try {
		return decodeURIComponent(match[1].trim().replace(/"$/, ''));
	} catch {
		return match[1].trim().replace(/"$/, '');
	}
}

function fromR2Object(object: R2Object | null | undefined, lockdiscovery = ''): DavProperties {
	if (object == null) {
		let now = new Date().toUTCString();
		return {
			creationdate: now,
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: now,
			resourcetype: '<collection />',
			supportedlock: SUPPORTED_LOCK_XML,
			lockdiscovery,
		};
	}
	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: extractFilenameFromDisposition(object.httpMetadata?.contentDisposition) ?? object.key.split('/').pop(),
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: sanitizeResourceType(object.customMetadata?.resourcetype),
		supportedlock: SUPPORTED_LOCK_XML,
		lockdiscovery,
	};
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

/* Lock permission checks: If-header evaluation (412) + lock tokens (423) */

async function assertLockPermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	options: {
		ignoreSharedLocksOnTarget?: boolean;
		table?: LockTable;
		/** Skip If evaluation for secondary paths (COPY/MOVE destination),
		 * where the If header belongs to the source resource. */
		skipIfEvaluation?: boolean;
	} = {},
): Promise<Response | null> {
	let table = options.table ?? (await readLockTable(bucket));

	// Active locks on the target and every ancestor (depth-infinity applies).
	let chainLocks: Array<{ path: string; locks: LockDetails[] }> = [];
	let activeTokens = new Set<string>();
	for (let path of ancestorChain(resourcePath)) {
		let locks = await getActiveLocks(bucket, path, table);
		chainLocks.push({ path, locks });
		for (let lock of locks) {
			activeTokens.add(lock.token);
		}
	}

	let claimedTokens: string[] = [];
	if (!options.skipIfEvaluation) {
		let target = await bucket.head(resourcePath);
		let evaluation = evaluateIfHeader(request.headers.get('If'), request, activeTokens, target?.etag ?? null);
		if (!evaluation.passed) {
			return fail(412);
		}
		claimedTokens = evaluation.tokens;
	}
	let lockTokens = [...new Set([...claimedTokens, ...getRequestLockTokens(request)])];

	for (let { path, locks } of chainLocks) {
		let relevant = locks.filter(
			(lock) =>
				(path === resourcePath || lock.depth === 'infinity') &&
				!(options.ignoreSharedLocksOnTarget && path === resourcePath && lock.scope === 'shared'),
		);
		if (relevant.length > 0 && !relevant.some((lock) => lockTokens.includes(lock.token))) {
			return fail(423);
		}
	}
	return null;
}

/** Recursive delete: the chain plus every descendant lock must be satisfied. */
async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<Response | null> {
	let table = await readLockTable(bucket);
	let denied = await assertLockPermission(request, bucket, resourcePath, { table });
	if (denied !== null) {
		return denied;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = resourcePath === '' ? '' : `${resourcePath}/`;
	for (let [path, entry] of table) {
		if (
			path !== resourcePath &&
			path.startsWith(prefix) &&
			path !== '' &&
			entry.locks.length > 0 &&
			!entry.locks.some((lock) => lockTokens.includes(lock.token))
		) {
			return fail(423);
		}
	}
	for await (let descendant of listAll(bucket, prefix, true)) {
		let locks = getLegacyLocks(descendant.customMetadata);
		if (locks.length > 0 && !locks.some((lock) => lockTokens.includes(lock.token))) {
			return fail(423);
		}
	}
	return null;
}

async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	table?: LockTable,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	let activeTable = table ?? (await readLockTable(bucket));
	for (let path of ancestorChain(resourcePath)) {
		let resource = await bucket.head(path);
		if (resource === null) {
			continue;
		}
		let lockDetails = (await getActiveLocks(bucket, path, activeTable)).find(
			(lock) => lockTokens.includes(lock.token) && (path === resourcePath || lock.depth === 'infinity'),
		);
		if (lockDetails !== undefined) {
			return { resource, lockDetails };
		}
	}
	return null;
}

/* Shared response / operation helpers */

function createdResponse(resourcePath: string, isCollection: boolean): Response {
	return new Response('', { status: 201, headers: { Location: getResourceHref(resourcePath, isCollection) } });
}

function getMaxListEntries(env: Env): number {
	let parsed = Number.parseInt(env.MAX_LIST_ENTRIES ?? '', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : MAX_LIST_ENTRIES_DEFAULT;
}

/** Shared COPY/MOVE pre-checks: Destination validity, lock permission on the
 * target, parent collection, Overwrite flag, source existence. */
async function prepareDestination(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	overwrite: boolean,
): Promise<{ error: Response } | { destination: string; destinationExists: boolean; resource: R2Object }> {
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return { error: fail(400) };
	}
	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null || isInternalPath(destination) || isSameOrDescendantPath(resourcePath, destination)) {
		return { error: fail(400) };
	}
	// The If header (if any) belongs to the source; only lock tokens apply here.
	let denied = await assertLockPermission(request, bucket, destination, { skipIfEvaluation: true });
	if (denied !== null) {
		return { error: denied };
	}
	if (!(await hasCollectionResource(bucket, getParentPath(destination)))) {
		return { error: fail(409) };
	}
	let destinationObject = await bucket.head(destination);
	if (!overwrite && destinationObject !== null) {
		return { error: fail(412) };
	}
	let resource = await bucket.head(resourcePath);
	if (resource === null || resource.key === destination) {
		return { error: fail(resource === null ? 404 : 400) };
	}
	return { destination, destinationExists: destinationObject !== null, resource };
}

/** Overwrite semantics: clear whatever occupies the destination first so a
 * file-over-directory copy cannot leave orphaned children behind. */
async function clearDestination(request: Request, bucket: R2Bucket, destination: string): Promise<Response | null> {
	let denied = await assertRecursiveDeletePermission(request, bucket, destination);
	if (denied !== null) {
		return denied;
	}
	await deleteResourceTree(bucket, destination);
	return null;
}

const hasBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => 'body' in object;

/* Handlers */

async function handleGet(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);

	if (request.url.endsWith('/')) {
		// Directory listing page.
		if (isInternalPath(resourcePath)) {
			return fail(404);
		}
		if (resourcePath !== '') {
			let resource = await bucket.head(resourcePath);
			if (!isCollectionObject(resource)) {
				return fail(404);
			}
		}
		let page = resourcePath === '' ? '' : `<a href="../">..</a><br>`;
		let prefix = resourcePath === '' ? '' : `${resourcePath}/`;
		let maxEntries = getMaxListEntries(env);
		let entryCount = 0;
		let truncated = false;
		for await (const object of listAll(bucket, prefix)) {
			if (object.key === resourcePath) {
				continue;
			}
			if (maxEntries > 0 && entryCount >= maxEntries) {
				truncated = true;
				break;
			}
			entryCount++;
			let href = getResourceHref(object.key, isCollectionObject(object));
			let name =
				extractFilenameFromDisposition(object.httpMetadata?.contentDisposition) ?? object.key.slice(prefix.length);
			page += `<a href="${escapeXml(href)}">${escapeXml(name)}</a><br>`;
		}
		if (truncated) {
			page += `<em>…listing truncated (${maxEntries} entries, set MAX_LIST_ENTRIES to change)</em><br>`;
		}
		return new Response(
			`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>${HTML_PAGE_STYLE}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`,
			{ headers: { 'Content-Type': 'text/html; charset=utf-8' } },
		);
	}

	if (isInternalPath(resourcePath)) {
		return fail(404);
	}
	let object = await bucket.get(resourcePath, { onlyIf: request.headers, range: request.headers });
	if (object === null) {
		return fail(404);
	}
	if (!hasBody(object)) {
		return fail(412);
	}

	const { rangeOffset, rangeEnd } = calcContentRange(object);
	const rangeRequested = request.headers.has('Range') && object.range !== undefined;
	let meta = object.httpMetadata ?? {};
	return new Response(object.body, {
		status: rangeRequested ? 206 : 200,
		headers: {
			'Accept-Ranges': 'bytes',
			'Content-Type': meta.contentType ?? 'application/octet-stream',
			'Content-Length': (rangeEnd - rangeOffset + 1).toString(),
			...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
			...(meta.contentDisposition ? { 'Content-Disposition': meta.contentDisposition } : {}),
			...(meta.contentEncoding ? { 'Content-Encoding': meta.contentEncoding } : {}),
			...(meta.contentLanguage ? { 'Content-Language': meta.contentLanguage } : {}),
			...(meta.cacheControl ? { 'Cache-Control': meta.cacheControl } : {}),
			...(meta.cacheExpiry ? { 'Cache-Expiry': meta.cacheExpiry.toISOString() } : {}),
		},
	});
}

async function handleHead(request: Request, env: Env): Promise<Response> {
	let response = await handleGet(request, env);
	return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			rangeOffset = object.size - object.range.suffix;
		} else {
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handlePut(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	if (request.url.endsWith('/')) {
		return fail(405);
	}
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(403);
	}
	let denied = await assertLockPermission(request, bucket, resourcePath);
	if (denied !== null) {
		return denied;
	}
	let existing = await bucket.head(resourcePath);
	if (!(await hasCollectionResource(bucket, getParentPath(resourcePath)))) {
		return fail(409);
	}

	// Stream the request body straight into R2 — no full buffering (encoded
	// bodies are buffered because their decoded form is needed).
	let body: ReadableStream | Uint8Array =
		request.body !== null && !request.headers.has('Content-Encoding')
			? request.body
			: new Uint8Array(await request.arrayBuffer());
	await bucket.put(resourcePath, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: stripLockMetadata(existing?.customMetadata),
	});
	return existing === null ? fail(201) : fail(204);
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(403);
	}
	let denied = await assertRecursiveDeletePermission(request, bucket, resourcePath);
	if (denied !== null) {
		return denied;
	}
	if (resourcePath !== '' && (await bucket.head(resourcePath)) === null) {
		return fail(404);
	}
	await deleteResourceTree(bucket, resourcePath);

	// Drop side-object locks covering the whole subtree.
	let table = await readLockTable(bucket);
	for (let path of table.keys()) {
		if (path === resourcePath || path.startsWith(`${resourcePath}/`)) {
			await bucket.delete(lockObjectKey(path));
		}
	}
	return fail(204);
}

async function handleMkcol(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return fail(415);
	}
	let resourcePath = makeResourcePath(request);
	if (resourcePath === '' || isInternalPath(resourcePath)) {
		return fail(403);
	}
	let denied = await assertLockPermission(request, bucket, resourcePath);
	if (denied !== null) {
		return denied;
	}
	if ((await bucket.head(resourcePath)) !== null) {
		return fail(405);
	}
	if (!(await hasCollectionResource(bucket, getParentPath(resourcePath)))) {
		return fail(409);
	}
	await bucket.put(resourcePath, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return fail(201);
}

/* PROPFIND / PROPPATCH */

function generatePropfindResponse(
	object: R2Object | null,
	propfindRequest: PropfindRequest,
	lockdiscovery: string,
): string {
	let href = object === null ? '/' : getResourceHref(object.key, isCollectionObject(object));
	let deadProperties = getDeadProperties(object?.customMetadata);
	let live = Object.entries(fromR2Object(object, lockdiscovery)).filter(([, value]) => value !== undefined);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop':
			okProperties = [
				...live.map(([key, value]) => renderDavProperty(key, value!)),
				...deadProperties.map((p) => renderPropertyElement(p)),
			];
			break;
		case 'propname':
			okProperties = [
				...live.map(([key]) => renderDavProperty(key, '')),
				...deadProperties.map((p) => renderPropertyElement(p, true)),
			];
			break;
		case 'prop':
			for (const property of propfindRequest.properties) {
				let liveValue =
					property.namespaceURI === 'DAV:'
						? (fromR2Object(object, lockdiscovery)[property.localName as keyof DavProperties] as string | undefined)
						: undefined;
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderPropertyElement(property, true));
				}
			}
			break;
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handlePropfind(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(404);
	}
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return fail(400);
	}

	let table = await readLockTable(bucket);
	let render = async (object: R2Object | null, path: string): Promise<string> => {
		let locks = await getActiveLocks(bucket, path, table);
		let discovery =
			locks.length === 0
				? ''
				: getLockDiscovery(
						locks.map((lock) => ({
							...lock,
							root: object === null ? lock.root : getResourceHref(object.key, isCollectionObject(object)),
						})),
					);
		return generatePropfindResponse(object, propfindRequest, discovery);
	};

	let isCollection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">`;
	if (resourcePath === '') {
		page += await render(null, '');
		isCollection = true;
	} else {
		let object = await bucket.head(resourcePath);
		if (object === null) {
			return fail(404);
		}
		isCollection = isCollectionObject(object);
		page += await render(object, resourcePath);
	}

	if (isCollection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		if (depth !== '0' && depth !== '1' && depth !== 'infinity') {
			return fail(400);
		}
		if (depth !== '0') {
			let prefix = resourcePath === '' ? '' : `${resourcePath}/`;
			let maxEntries = getMaxListEntries(env);
			let entryCount = 0;
			for await (let object of listAll(bucket, prefix, depth === 'infinity')) {
				if (maxEntries > 0 && entryCount >= maxEntries) {
					console.warn(`r2-webdav: PROPFIND response truncated at ${maxEntries} entries`);
					break;
				}
				entryCount++;
				page += await render(object, object.key);
			}
		}
	}

	return new Response(`${page}\n</multistatus>\n`, {
		status: 207,
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
}

async function handleProppatch(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(404);
	}
	let denied = await assertLockPermission(request, bucket, resourcePath);
	if (denied !== null) {
		return denied;
	}
	let object = await bucket.head(resourcePath);
	if (object === null) {
		return fail(404);
	}
	let parsedRequest = parseProppatchRequest(await request.text());
	if (parsedRequest === null) {
		return fail(400);
	}

	const customMetadata = stripLockMetadata(object.customMetadata);
	let okProperties: DeadProperty[] = [];
	let failedProperties: DeadProperty[] = [];
	for (const { action, property } of parsedRequest.operations) {
		// Lock-related and malformed properties can never be written.
		if (!/^[A-Za-z_][A-Za-z0-9._:-]*$/.test(property.localName) || isProtectedProperty(property)) {
			failedProperties.push(property);
			continue;
		}
		let key = getDeadPropertyKey(property.namespaceURI, property.localName);
		if (action === 'set') {
			customMetadata[key] = JSON.stringify(property);
		} else {
			delete customMetadata[key];
		}
		okProperties.push(property);
	}

	const hasFailures = failedProperties.length > 0;
	if (!hasFailures) {
		// Stream the object body back with only metadata changed.
		const src = await bucket.get(object.key);
		if (src === null) {
			return fail(404);
		}
		await bucket.put(object.key, src.body, { httpMetadata: object.httpMetadata, customMetadata });
	}

	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';
	let propstats = new Map<string, string[]>();
	const appendAll = (properties: DeadProperty[], status: string) => {
		for (const property of properties) {
			let props = propstats.get(status) ?? [];
			props.push(renderPropertyElement({ ...property, valueXml: '' }, true));
			propstats.set(status, props);
		}
	};
	appendAll(okProperties, successStatus);
	appendAll(failedProperties, 'HTTP/1.1 403 Forbidden');

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, isCollectionObject(object)))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((name) => `\t\t\t\t${name}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';
	return new Response(responseXML, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

/* COPY / MOVE */

async function handleCopy(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(404);
	}
	let overwrite = request.headers.get('Overwrite') !== 'F';
	let prepared = await prepareDestination(request, bucket, resourcePath, overwrite);
	if ('error' in prepared) {
		return prepared.error;
	}
	let { destination, destinationExists, resource } = prepared;

	if (destinationExists) {
		let cleared = await clearDestination(request, bucket, destination);
		if (cleared !== null) {
			return cleared;
		}
	}
	const putCopy = async (sourceKey: string, targetKey: string) => {
		let source = await bucket.get(sourceKey);
		if (source !== null) {
			await bucket.put(targetKey, source.body, {
				httpMetadata: source.httpMetadata,
				customMetadata: stripLockMetadata(source.customMetadata),
			});
		}
	};

	if (!isCollectionObject(resource)) {
		await putCopy(resource.key, destination);
	} else {
		let depth = request.headers.get('Depth') ?? 'infinity';
		if (depth !== 'infinity' && depth !== '0') {
			return fail(400);
		}
		if (depth === '0') {
			await putCopy(resource.key, destination);
		} else {
			let prefix = `${resourcePath}/`;
			let operations: Array<[string, string]> = [[resource.key, destination]];
			for await (let object of listAll(bucket, prefix, true)) {
				let target = `${destination}/${object.key.slice(prefix.length)}`.replace(/\/$/, '');
				operations.push([object.key, target]);
			}
			await forEachConcurrent(operations, DEFAULT_CONCURRENCY, ([sourceKey, targetKey]) =>
				putCopy(sourceKey, targetKey),
			);
		}
	}
	return destinationExists ? fail(204) : createdResponse(destination, isCollectionObject(resource));
}

async function handleMove(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (isInternalPath(resourcePath)) {
		return fail(404);
	}
	let sourceDenied = await assertLockPermission(request, bucket, resourcePath);
	if (sourceDenied !== null) {
		return sourceDenied;
	}
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let prepared = await prepareDestination(request, bucket, resourcePath, overwrite);
	if ('error' in prepared) {
		return prepared.error;
	}
	let { destination, destinationExists, resource } = prepared;

	if (destinationExists) {
		let cleared = await clearDestination(request, bucket, destination);
		if (cleared !== null) {
			return cleared;
		}
	}

	// Locks follow the resource to its new path (RFC 4918 §9.9.1), with
	// lockroot rewritten to the destination.
	let table = await readLockTable(bucket);
	let migrated: Array<{ sourcePath: string; targetPath: string; locks: LockDetails[] }> = [];
	for (let [path, entry] of table) {
		if (path === resourcePath || path.startsWith(`${resourcePath}/`)) {
			let targetPath = destination + path.slice(resourcePath.length);
			migrated.push({
				sourcePath: path,
				targetPath,
				locks: entry.locks.map((lock) => ({ ...lock, root: getResourceHref(targetPath, lock.root.endsWith('/')) })),
			});
		}
	}

	if (isCollectionObject(resource)) {
		if ((request.headers.get('Depth') ?? 'infinity') !== 'infinity') {
			return fail(400);
		}
		let prefix = `${resourcePath}/`;
		let operations: Array<[string, string]> = [[resource.key, destination]];
		for await (let object of listAll(bucket, prefix, true)) {
			let target = `${destination}/${object.key.slice(prefix.length)}`.replace(/\/$/, '');
			operations.push([object.key, target]);
		}
		await forEachConcurrent(operations, DEFAULT_CONCURRENCY, async ([sourceKey, targetKey]) => {
			let source = await bucket.get(sourceKey);
			if (source !== null) {
				await bucket.put(targetKey, source.body, {
					httpMetadata: source.httpMetadata,
					customMetadata: stripLockMetadata(source.customMetadata),
				});
				await bucket.delete(sourceKey);
			}
		});
	} else {
		let source = await bucket.get(resource.key);
		if (source === null) {
			return fail(404);
		}
		await bucket.put(destination, source.body, {
			httpMetadata: source.httpMetadata,
			customMetadata: stripLockMetadata(source.customMetadata),
		});
		await bucket.delete(resource.key);
	}

	for (let { sourcePath, targetPath, locks } of migrated) {
		await bucket.delete(lockObjectKey(sourcePath));
		if (locks.length > 0) {
			await writeLocks(bucket, targetPath, locks);
		}
	}
	return destinationExists ? fail(204) : createdResponse(destination, isCollectionObject(resource));
}

/* LOCK / UNLOCK */

async function handleLock(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (resourcePath === '' || isInternalPath(resourcePath)) {
		return fail(400);
	}
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return fail(400);
	}
	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// An empty LOCK body means "refresh" (RFC 4918 §9.10.6).
	let isRefresh = body === '';
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	if (!isRefresh && !/<write\b/i.test(body)) {
		return fail(400);
	}
	let owner = extractLockOwner(body);

	let table = await readLockTable(bucket);
	let denied = await assertLockPermission(request, bucket, resourcePath, {
		ignoreSharedLocksOnTarget: !isRefresh && requestedScope === 'shared',
		table,
	});
	if (denied !== null) {
		return denied;
	}

	let refreshTarget = isRefresh ? await findMatchingLock(request, bucket, resourcePath, table) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resourcePath));
	let existingLock = refreshTarget?.lockDetails;
	let currentLocks = (await getActiveLocks(bucket, resourcePath, table)).filter(
		(lock) => lock.token !== existingLock?.token,
	);

	// Refresh of a locked resource without the right token → 423.
	let requestLockTokens = getRequestLockTokens(request);
	if (
		isRefresh &&
		refreshTarget === null &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((lock) => requestLockTokens.includes(lock.token))
	) {
		return fail(423);
	}

	if (resource === null) {
		if (isRefresh) {
			return fail(400);
		}
		// Lock a missing resource by creating a lock-null (empty) resource.
		if (!(await hasCollectionResource(bucket, getParentPath(resourcePath))) || request.url.endsWith('/')) {
			return fail(409);
		}
		await bucket.put(resourcePath, new Uint8Array(), { customMetadata: {} });
		resource = await bucket.head(resourcePath);
		if (resource === null) {
			return fail(404);
		}
	}

	if (
		existingLock === undefined &&
		((requestedScope === 'exclusive' && currentLocks.length > 0) ||
			(requestedScope === 'shared' && currentLocks.some((lock) => lock.scope === 'exclusive')))
	) {
		return fail(423);
	}

	// Refresh without Depth keeps the original lock depth (no silent broadening).
	let depth =
		existingLock !== undefined && depthHeader === null && isRefresh
			? existingLock.depth
			: determineLockDepth(
					resource.customMetadata?.resourcetype,
					depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
				);

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, isCollectionObject(resource)),
	};
	let updatedLocks = [...currentLocks, lockDetails];
	await writeLocks(bucket, resourcePath, updatedLocks);

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				...(existingLock ? {} : { Location: getResourceHref(resource.key, isCollectionObject(resource)) }),
			},
		},
	);
}

function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): '0' | 'infinity' {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

async function handleUnlock(request: Request, env: Env): Promise<Response> {
	let { bucket } = env;
	let resourcePath = makeResourcePath(request);
	if (resourcePath === '' || isInternalPath(resourcePath)) {
		return fail(404);
	}
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return fail(404);
	}
	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return fail(400);
	}
	// RFC 4918 §9.11.1: validity depends only on the token matching an active
	// lock; a non-matching token is 409, not a lock-precondition failure.
	let token = normalizeLockToken(lockToken);

	let entry = await readLockEntry(bucket, resourcePath);
	let remaining = entry.locks.filter((lock) => lock.token !== token);
	if (remaining.length !== entry.locks.length) {
		if (remaining.length === 0) {
			await bucket.delete(lockObjectKey(resourcePath));
		} else {
			await writeLocks(bucket, resourcePath, remaining);
		}
		return fail(204);
	}

	// Legacy metadata lock: rewrite object metadata to drop the lock.
	let legacyLocks = getLegacyLocks(resource.customMetadata);
	let remainingLegacy = legacyLocks.filter((lock) => lock.token !== token);
	if (remainingLegacy.length !== legacyLocks.length) {
		let source = await bucket.get(resource.key);
		if (source === null) {
			return fail(404);
		}
		let metadata = stripLockMetadata(resource.customMetadata);
		if (remainingLegacy.length > 0) {
			metadata['lock_records'] = JSON.stringify(remainingLegacy);
		}
		await bucket.put(resource.key, source.body, { httpMetadata: resource.httpMetadata, customMetadata: metadata });
		return fail(204);
	}
	return fail(409);
}

/* Dispatch & entry point */

async function handleOptions(): Promise<Response> {
	return new Response(null, { status: 200, headers: DAV_HEADERS });
}

const HANDLERS: Record<string, (request: Request, env: Env) => Promise<Response>> = {
	HEAD: handleHead,
	GET: handleGet,
	PUT: handlePut,
	DELETE: handleDelete,
	MKCOL: handleMkcol,
	PROPFIND: handlePropfind,
	PROPPATCH: handleProppatch,
	COPY: handleCopy,
	MOVE: handleMove,
	LOCK: handleLock,
	UNLOCK: handleUnlock,
};

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return handleOptions();
		}
		// Internal objects are never exposed over WebDAV.
		let requestPath = makeResourcePath(request);
		if (isInternalPath(requestPath)) {
			return fail(404);
		}
		if (!isAuthorized(request, resolveCredentials(env))) {
			return fail(401, { headers: { 'WWW-Authenticate': 'Basic realm="webdav"' } });
		}

		let handler = HANDLERS[request.method];
		let response = handler ? await handler(request, env) : fail(405, { headers: DAV_HEADERS });

		// MS-Author-Via helps Windows Mini-Redirector detect WebDAV support.
		if (!response.headers.has('MS-Author-Via')) {
			response.headers.set('MS-Author-Via', 'DAV');
		}
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
		response.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');
		return response;
	},
};
