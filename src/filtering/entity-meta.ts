/**
 * Runtime entity metadata resolution.
 *
 * Container props expose associations as opaque ids (`{ id, filterable }`)
 * with no entity information, so parent/child relationships for cascading
 * combo boxes cannot be derived from the props alone.
 *
 * The Mendix client ships the full domain-model metadata in the session
 * data (`mx.session.sessionData.metadata`): an array of entity descriptors
 * keyed by numeric entity id, each carrying `objectType` (the fully
 * qualified entity name) and `attributes` whose entries of type
 * `ObjectReference` / `ObjectReferenceSet` expose the target entity via
 * `klass`. This gives a complete, synchronous reference graph without any
 * server round-trips — which is essential because a cascade child's data
 * source may legitimately be limited to zero items (no GUIDs to resolve
 * through `mx.data.get`), yet the cascade still needs to know that e.g.
 * `MyFirstModule.District` references `MyFirstModule.Province`.
 */
export interface EntityMeta {
    /** Fully qualified entity name, e.g. `MyFirstModule.District`. */
    entity: string;
    /** Target entity names of the entity's reference attributes. */
    refs: string[];
}

interface SessionAttribute {
    type?: string;
    klass?: string;
}

interface SessionEntityMeta {
    objectType?: string;
    entityId?: number;
    attributes?: Record<string, SessionAttribute | undefined>;
}

/**
 * Builds the reference graph straight from the client-side domain model.
 * Returns an empty map when the session metadata is not (yet) available;
 * callers treat that as "unknown" and simply retry on a later run.
 */
export function getDomainGraph(): Map<string, EntityMeta> {
    const graph = new Map<string, EntityMeta>();
    const mx = (
        window as unknown as {
            mx?: { session?: { sessionData?: { metadata?: Record<string, SessionEntityMeta> } } };
        }
    ).mx;
    const metadata = mx?.session?.sessionData?.metadata;
    if (!metadata) {
        return graph;
    }
    for (const key of Object.keys(metadata)) {
        const entry = metadata[key];
        const entity = entry?.objectType;
        if (!entity) {
            continue;
        }
        const refs: string[] = [];
        for (const attrName of Object.keys(entry.attributes ?? {})) {
            const attr = entry.attributes?.[attrName];
            if (attr && (attr.type === "ObjectReference" || attr.type === "ObjectReferenceSet") && attr.klass) {
                refs.push(attr.klass);
            }
        }
        graph.set(entity, { entity, refs });
    }
    return graph;
}

/**
 * Resolves the entity name and reference targets behind a GUID. Resolves to
 * `undefined` when the client API is unavailable or the lookup fails —
 * callers treat that as "unknown" rather than an error.
 *
 * Results are cached per GUID (entity metadata is immutable for the lifetime
 * of the page) so repeated effect runs never flood the client API with
 * duplicate requests, and a timeout guarantees the promise always settles.
 */
const metaCache = new Map<string, Promise<EntityMeta | undefined>>();

/** Minimal shape of the Mendix object handed back by `mx.data.get`. */
interface MxObjectLike {
    getEntity(): string;
    getReferenceAttributes?: () => string[];
    metaData?: {
        attributes?: Record<string, { referenceEntity?: string } | undefined>;
    };
}

/** Minimal shape of the global `mx` client API used here. */
interface MxClientApi {
    data?: {
        get?: (options: {
            guid: string;
            callback: (obj: MxObjectLike) => void;
            error: (error: unknown) => void;
        }) => void;
    };
}

const FETCH_TIMEOUT_MS = 5000;

export function fetchEntityMeta(guid: string): Promise<EntityMeta | undefined> {
    const cached = metaCache.get(guid);
    if (cached) {
        return cached;
    }
    const promise = new Promise<EntityMeta | undefined>(resolve => {
        let settled = false;
        const finish = (meta: EntityMeta | undefined): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                // Only successful lookups stay cached. A transient failure
                // must NOT poison the cache — drop the entry so a later run
                // retries.
                if (meta === undefined) {
                    metaCache.delete(guid);
                }
                resolve(meta);
            }
        };
        const timer = setTimeout(() => finish(undefined), FETCH_TIMEOUT_MS);

        const mx = (window as unknown as { mx?: MxClientApi }).mx;
        const data = mx?.data;
        const get = data?.get;
        if (!get) {
            finish(undefined);
            return;
        }
        try {
            // Call as a method of `mx.data` — the client API relies on
            // `this`, so an unbound call would throw synchronously.
            get.call(data, {
                guid,
                callback: obj => {
                    try {
                        const attrs = obj.metaData?.attributes ?? {};
                        const refs = (obj.getReferenceAttributes?.() ?? [])
                            .map(name => attrs[name]?.referenceEntity)
                            .filter((target): target is string => typeof target === "string");
                        finish({ entity: obj.getEntity(), refs });
                    } catch {
                        finish(undefined);
                    }
                },
                error: () => finish(undefined)
            });
        } catch {
            finish(undefined);
        }
    });
    metaCache.set(guid, promise);
    return promise;
}

/**
 * Maps a runtime object GUID to its entity name using pure client-side
 * data: the top 16 bits of a Mendix 64-bit object id encode the numeric
 * entity id (`entityId`), which the session metadata carries alongside the
 * fully qualified entity name (`objectType`). This makes id → entity
 * resolution synchronous and independent of `mx.data.get`, whose callbacks
 * are unreliable when invoked from within widget effect code.
 */
export function entityOfGuid(guid: string): string | undefined {
    const mx = (
        window as unknown as {
            mx?: { session?: { sessionData?: { metadata?: Record<string, SessionEntityMeta> } } };
        }
    ).mx;
    const metadata = mx?.session?.sessionData?.metadata;
    if (!metadata) {
        return undefined;
    }
    let entityId: number;
    try {
        entityId = Number(BigInt(guid) >> BigInt(48));
    } catch {
        return undefined;
    }
    for (const key of Object.keys(metadata)) {
        if (metadata[key]?.entityId === entityId) {
            return metadata[key].objectType;
        }
    }
    return undefined;
}
