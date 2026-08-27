/**
 * Plain-class filter stores for the Data grid 2 shared filter context.
 *
 * IMPORTANT: these stores deliberately avoid mobx. Widgets are bundled with
 * mobx as a per-widget dependency (it is not in the shared externals list),
 * so a mobx observable created inside this widget would not interoperate with
 * the observable classes living inside Data grid 2's bundle. The filter host
 * only needs the duck-typed surface defined by `FilterLike`, which plain
 * classes satisfy perfectly.
 *
 * Re-registration strategy: because our stores are not reactive, the host's
 * autoruns cannot track our mutations. Instead, after every state mutation
 * the component calls `syncFilter()`, which unobserves and re-observes the
 * store under the same key. `observe()` creates fresh synchronous autoruns
 * that read the up-to-date `condition` and push it into the grid state.
 * The `suppressed` flag shields the store from the stale personalization
 * replay that the host performs synchronously inside `observe()`.
 */
import { association, attribute, contains, dayEquals, equals, literal, or } from "mendix/filters/builders";
import type { ObjectItem } from "mendix";
import Big from "big.js";

import type { FilterLike, ObservableFilterHost } from "./global-context";

/** Branded id types expected by the filter builders. */
type AttrId = Parameters<typeof attribute>[0];
type AssocId = Parameters<typeof association>[0];

/** Union of concrete conditions the builders in this module produce. */
export type BuiltCondition =
    | ReturnType<typeof equals>
    | ReturnType<typeof contains>
    | ReturnType<typeof dayEquals>
    | ReturnType<typeof or>;

/**
 * Minimal structural description of the attribute metadata this module relies
 * on. Assignment-compatible with the `ListAttributeValue<...>` unions found in
 * the generated widget props, without the generic/branded typing friction.
 */
export interface SearchAttributeLike {
    readonly id: string;
    readonly filterable: boolean;
    readonly type: string;
    readonly universe?: readonly unknown[];
    readonly formatter: { format(value?: unknown): string };
}

/** Minimal structural description of association metadata. */
export interface SearchAssociationLike {
    readonly id: string;
    readonly filterable: boolean;
}

/** Minimal structural description of the caption attribute over the options data source. */
export interface OptionCaptionSource {
    get(item: ObjectItem): { displayValue: string; value?: string };
}

/**
 * JSON-safe serialization of a single field's filter state. The format is
 * private to this widget: the filter host persists whatever `toJSON()`
 * returns and hands it back to `fromJSON()`/`fromViewState()`, so only
 * round-trip stability matters.
 */
export type SerializedFilter =
    | ["contains", string, string]
    | ["equal", string, string[]]
    | ["dayEquals", string, string]
    | ["ref", string, string[]];

export abstract class BaseFilterStore implements FilterLike {
    /**
     * While true, incoming `fromJSON` replays are ignored. Set by
     * `syncFilter()` around the unobserve/observe cycle.
     */
    suppressed = false;

    /** `undefined` means "no filter for this field". */
    abstract get condition(): BuiltCondition | undefined;

    abstract toJSON(): SerializedFilter | null;

    fromViewState(data: unknown): void {
        this.fromJSON(data);
    }

    fromJSON(data: unknown): void {
        if (this.suppressed) {
            return;
        }
        const next = this.deserialize(data);
        // Idempotence guard: skipping identical updates prevents redundant
        // reactions (and potential feedback loops) in the host.
        if (serializeEqual(next, this.toJSON())) {
            return;
        }
        this.apply(next);
    }

    /** Clears the filter state (used by the Clear button). */
    reset(): void {
        this.apply(null);
    }

    protected abstract deserialize(data: unknown): SerializedFilter | null;
    protected abstract apply(next: SerializedFilter | null): void;
}

function serializeEqual(a: SerializedFilter | null, b: SerializedFilter | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Attribute types whose values are numeric. XPath `contains()` is only
 * valid on string attributes — the runtime throws
 * "asString(...).includes is not a function" when given a numeric
 * attribute — so these fall back to an exact numeric match.
 */
const NUMERIC_TYPES = new Set(["Decimal", "Integer", "Long", "AutoNumber", "Float"]);

/**
 * Free-text search over textual attributes via `contains`; numeric
 * attributes (Decimal, Integer, Long, ...) use an exact `equals` match
 * with a numeric literal instead.
 */
export class TextFilterStore extends BaseFilterStore {
    text = "";

    constructor(private readonly attr: SearchAttributeLike) {
        super();
    }

    setText(value: string): void {
        this.text = value;
    }

    get condition(): BuiltCondition | undefined {
        const needle = this.text.trim();
        if (!needle || !this.attr.filterable) {
            return undefined;
        }
        const expr = attribute(this.attr.id as AttrId);
        if (NUMERIC_TYPES.has(this.attr.type)) {
            // Numeric literals must be Big (big.js) — literal() rejects plain
            // numbers. Non-numeric input cannot match anything; produce no
            // condition rather than an invalid one.
            let value: Big | undefined;
            try {
                value = new Big(needle.replace(",", "."));
            } catch {
                value = undefined;
            }
            return value !== undefined ? equals(expr, literal(value)) : undefined;
        }
        return contains(expr, literal(needle));
    }

    toJSON(): SerializedFilter | null {
        return this.text ? ["contains", this.attr.id, this.text] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[0] !== "contains" || data[1] !== this.attr.id) {
            return null;
        }
        const text = data[2];
        return typeof text === "string" ? ["contains", this.attr.id, text] : null;
    }

    protected apply(next: SerializedFilter | null): void {
        this.text = next && next[0] === "contains" ? next[2] : "";
    }
}

/**
 * Selection filter over Enum and Boolean attributes. Options come from the
 * attribute's `universe`; captions are rendered with the attribute formatter.
 * Multiple selections combine with `or`.
 */
export class SelectFilterStore extends BaseFilterStore {
    /** Raw universe values, string-encoded for serialization. */
    values: string[] = [];

    constructor(private readonly attr: SearchAttributeLike) {
        super();
    }

    setValues(values: string[]): void {
        // Keep only values that still exist in the universe.
        const universe = this.attr.universe?.map(v => String(v));
        this.values = universe ? values.filter(v => universe.includes(v)) : [...values];
    }

    toggleValue(value: string): void {
        this.setValues(this.values.includes(value) ? this.values.filter(v => v !== value) : [...this.values, value]);
    }

    get condition(): BuiltCondition | undefined {
        if (!this.attr.filterable || this.values.length === 0) {
            return undefined;
        }
        const expr = attribute(this.attr.id as AttrId);
        const conditions = this.values.map(value =>
            equals(expr, literal(this.attr.type === "Boolean" ? value === "true" : value))
        );
        return conditions.length === 1 ? conditions[0] : or(...conditions);
    }

    toJSON(): SerializedFilter | null {
        return this.values.length > 0 ? ["equal", this.attr.id, [...this.values]] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[0] !== "equal" || data[1] !== this.attr.id || !Array.isArray(data[2])) {
            return null;
        }
        const values = data[2].filter((v): v is string => typeof v === "string");
        return ["equal", this.attr.id, values];
    }

    protected apply(next: SerializedFilter | null): void {
        this.values = next && next[0] === "equal" ? [...next[2]] : [];
    }
}

/**
 * Date filter over DateTime attributes. Compares calendar days via
 * `dayEquals`, so time-of-day components are ignored.
 */
export class DateFilterStore extends BaseFilterStore {
    /** ISO `yyyy-mm-dd`, as produced by `<input type="date">`. */
    date = "";

    constructor(private readonly attr: SearchAttributeLike) {
        super();
    }

    setDate(value: string): void {
        this.date = value;
    }

    get condition(): BuiltCondition | undefined {
        const parsed = parseIsoDate(this.date);
        if (!parsed || !this.attr.filterable) {
            return undefined;
        }
        return dayEquals(attribute(this.attr.id as AttrId), literal(parsed));
    }

    toJSON(): SerializedFilter | null {
        return this.date ? ["dayEquals", this.attr.id, this.date] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[0] !== "dayEquals" || data[1] !== this.attr.id) {
            return null;
        }
        const date = data[2];
        return typeof date === "string" && parseIsoDate(date) ? ["dayEquals", this.attr.id, date] : null;
    }

    protected apply(next: SerializedFilter | null): void {
        this.date = next && next[0] === "dayEquals" ? next[2] : "";
    }
}

/**
 * Selection filter over associations. Selectable objects are the items of the
 * configured options data source; the store keeps their GUIDs.
 *
 * Filter literals must be REAL objects taken from the options data source —
 * `literal()` rejects plain `{ id }` stand-ins. The reference type (single
 * `Reference` vs. many `ReferenceSet`) is not part of `AssociationMetaData`,
 * so — like Mendix's own RefFilterStore — each condition is built with a
 * `contains()` attempt that falls back to `equals()` when it throws.
 */
export class ReferenceFilterStore extends BaseFilterStore {
    ids: string[] = [];

    /** Real objects from the options data source, keyed by id when filtering. */
    options: ObjectItem[] = [];

    constructor(private readonly assoc: SearchAssociationLike) {
        super();
    }

    setOptions(options: ObjectItem[]): void {
        this.options = [...options];
    }

    setIds(ids: string[]): void {
        this.ids = [...ids];
    }

    toggleId(id: string): void {
        this.ids = this.ids.includes(id) ? this.ids.filter(x => x !== id) : [...this.ids, id];
    }

    get condition(): BuiltCondition | undefined {
        if (!this.assoc.filterable || this.ids.length === 0) {
            return undefined;
        }
        const expr = association(this.assoc.id as AssocId);
        const byId = new Map(this.options.map(item => [String(item.id), item]));
        const conditions: BuiltCondition[] = [];
        for (const id of this.ids) {
            const obj = byId.get(id);
            // Objects not (yet) present in the options data source cannot be
            // turned into a valid literal; skip them until they load.
            if (!obj) {
                continue;
            }
            try {
                // Reference sets accept contains(); single references do not.
                conditions.push(contains(expr, literal(obj)));
            } catch {
                conditions.push(equals(expr, literal(obj)));
            }
        }
        if (conditions.length === 0) {
            return undefined;
        }
        return conditions.length === 1 ? conditions[0] : or(...conditions);
    }

    toJSON(): SerializedFilter | null {
        return this.ids.length > 0 ? ["ref", this.assoc.id, [...this.ids]] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[0] !== "ref" || data[1] !== this.assoc.id || !Array.isArray(data[2])) {
            return null;
        }
        const ids = data[2].filter((v): v is string => typeof v === "string");
        return ["ref", this.assoc.id, ids];
    }

    protected apply(next: SerializedFilter | null): void {
        this.ids = next && next[0] === "ref" ? [...next[2]] : [];
    }
}

export interface UniverseOption {
    value: string;
    caption: string;
}

/** Builds combo box options from an Enum/Boolean attribute universe. */
export function getUniverseOptions(attr: SearchAttributeLike): UniverseOption[] {
    const universe = attr.universe;
    if (!universe) {
        return [];
    }
    return universe.map(value => ({ value: String(value), caption: attr.formatter.format(value) }));
}

export interface ReferenceOption {
    id: string;
    caption: string;
}

/** Builds combo box options from the options data source items. */
export function getReferenceOptions(
    items: ObjectItem[] | undefined,
    captionSource: OptionCaptionSource | undefined
): ReferenceOption[] {
    if (!items) {
        return [];
    }
    return items.map(item => ({
        id: item.id,
        caption: captionSource ? captionSource.get(item).displayValue || item.id : item.id
    }));
}

/** Creates the appropriate store for an attribute based on its type. */
export function createAttributeStore(attr: SearchAttributeLike): BaseFilterStore {
    switch (attr.type) {
        case "Enum":
        case "Boolean":
            return new SelectFilterStore(attr);
        case "DateTime":
            return new DateFilterStore(attr);
        default:
            return new TextFilterStore(attr);
    }
}

/**
 * Re-registers a store under `key`. Unobserve + observe creates fresh
 * synchronous autoruns that pick up the store's current condition; the
 * suppression flag prevents the host's synchronous settings replay from
 * clobbering the newest in-memory state with persisted (older) data.
 */
export function syncFilter(observer: ObservableFilterHost, key: string, store: BaseFilterStore): void {
    store.suppressed = true;
    try {
        observer.unobserve(key);
        observer.observe(key, store);
    } finally {
        store.suppressed = false;
    }
}

/** Removes a store registration (component unmount / key change). */
export function unsyncFilter(observer: ObservableFilterHost, key: string): void {
    observer.unobserve(key);
}

function parseIsoDate(value: string): Date | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return undefined;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? undefined : date;
}
