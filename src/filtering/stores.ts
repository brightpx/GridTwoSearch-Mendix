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
import {
    and,
    association,
    attribute,
    contains,
    dayEquals,
    empty,
    equals,
    greaterThanOrEqual,
    lessThanOrEqual,
    literal,
    not,
    or
} from "mendix/filters/builders";
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
    | ReturnType<typeof or>
    | ReturnType<typeof greaterThanOrEqual>
    | ReturnType<typeof lessThanOrEqual>
    | ReturnType<typeof and>;

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
 * Minimal structural description of a per-item value reader over the options
 * data source. Satisfied by `ListAttributeValue` (whose `get()` returns an
 * `EditableValue` with `status`/`value`) — used to read the comparison value
 * of the option-side match attribute.
 */
export interface OptionValueSource {
    get(item: ObjectItem): { status: string; value?: unknown };
}

/** A text template bound to the options data source (`ListExpressionValue<string>`). */
export interface OptionTemplateSource {
    get(item: ObjectItem): { status: string; value?: string };
}

/**
 * Attribute-match configuration for a reference field: instead of filtering
 * the association itself, the grid-side attribute is compared with the value
 * of the option-side attribute of each picked option object. Example: grid
 * attribute `LoanFacility/AOUserName` equals option attribute
 * `OrgUnit.User/Username` of the selected user object.
 */
export interface ReferenceMatchConfig {
    /** Attribute id on the Data grid 2 data source entity. */
    attributeId: string;
    /** Attribute type name ("String", "Integer", "DateTime", ...). */
    attributeType: string;
    /** Whether the grid-side attribute may be used in filter conditions. */
    filterable: boolean;
    /** Per-option value reader (the option-side attribute). */
    optionAttribute: OptionValueSource;
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
    | ["dateRange", string, string, string]
    | ["ref", string, string[]]
    | ["refmatch", string, string[]];

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
 * Selection filter over a fixed list of options entered in Studio
 * (Static options mode). Each option carries a value compared with the
 * target attribute via an exact `equals` match, and a caption shown to the
 * end user. Unlike SelectFilterStore there is no universe to validate
 * against: configured values are trusted as-is.
 */
export class StaticFilterStore extends BaseFilterStore {
    /** Values of the picked options, string-encoded for serialization. */
    values: string[] = [];

    constructor(
        private readonly attrId: string,
        private readonly attrType: string,
        private readonly filterable: boolean
    ) {
        super();
    }

    setValues(values: string[]): void {
        this.values = [...values];
    }

    get condition(): BuiltCondition | undefined {
        if (!this.filterable || this.values.length === 0) {
            return undefined;
        }
        const expr = attribute(this.attrId as AttrId);
        const conditions = this.values.map(value =>
            equals(expr, literal(this.attrType === "Boolean" ? value === "true" : value))
        );
        return conditions.length === 1 ? conditions[0] : or(...conditions);
    }

    toJSON(): SerializedFilter | null {
        return this.values.length > 0 ? ["equal", this.attrId, [...this.values]] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[0] !== "equal" || data[1] !== this.attrId || !Array.isArray(data[2])) {
            return null;
        }
        const values = data[2].filter((v): v is string => typeof v === "string");
        return ["equal", this.attrId, values];
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

    /** ISO `yyyy-mm-dd` bounds for range search; either side may be empty. */
    dateFrom = "";
    dateTo = "";

    constructor(private readonly attr: SearchAttributeLike) {
        super();
    }

    setDate(value: string): void {
        this.date = value;
    }

    setDateRange(from: string, to: string): void {
        this.dateFrom = from;
        this.dateTo = to;
    }

    get condition(): BuiltCondition | undefined {
        if (!this.attr.filterable) {
            return undefined;
        }
        const expr = attribute(this.attr.id as AttrId);
        if (this.dateFrom || this.dateTo) {
            // Inclusive calendar-day range: [from 00:00:00.000, to 23:59:59.999],
            // so records with a time-of-day component still match their day.
            const bounds: BuiltCondition[] = [];
            const from = parseIsoDate(this.dateFrom);
            if (from) {
                bounds.push(greaterThanOrEqual(expr, literal(dayStart(from))));
            }
            const to = parseIsoDate(this.dateTo);
            if (to) {
                bounds.push(lessThanOrEqual(expr, literal(dayEnd(to))));
            }
            if (bounds.length === 0) {
                return undefined;
            }
            return bounds.length === 1 ? bounds[0] : and(...bounds);
        }
        const parsed = parseIsoDate(this.date);
        if (!parsed) {
            return undefined;
        }
        return dayEquals(expr, literal(parsed));
    }

    toJSON(): SerializedFilter | null {
        if (this.dateFrom || this.dateTo) {
            return ["dateRange", this.attr.id, this.dateFrom, this.dateTo];
        }
        return this.date ? ["dayEquals", this.attr.id, this.date] : null;
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (Array.isArray(data) && data[0] === "dateRange" && data[1] === this.attr.id) {
            const from = data[2];
            const to = data[3];
            if (
                typeof from === "string" &&
                typeof to === "string" &&
                (from === "" || parseIsoDate(from)) &&
                (to === "" || parseIsoDate(to))
            ) {
                return ["dateRange", this.attr.id, from, to];
            }
            return null;
        }
        if (!Array.isArray(data) || data[0] !== "dayEquals" || data[1] !== this.attr.id) {
            return null;
        }
        const date = data[2];
        return typeof date === "string" && parseIsoDate(date) ? ["dayEquals", this.attr.id, date] : null;
    }

    protected apply(next: SerializedFilter | null): void {
        if (next && next[0] === "dateRange") {
            this.date = "";
            this.dateFrom = next[2];
            this.dateTo = next[3];
            return;
        }
        this.dateFrom = "";
        this.dateTo = "";
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

    /**
     * Attribute-match mode. When set, the filter compares the grid-side
     * attribute with the option-side attribute value of each picked object
     * instead of filtering the association itself.
     */
    private matchConfig: ReferenceMatchConfig | undefined;

    /**
     * Last known match-attribute value per option id. A data source reload
     * replaces the option objects and their values arrive asynchronously;
     * the cache keeps the built condition stable across such reloads
     * instead of silently dropping the filter while values are loading.
     */
    private valueCache = new Map<string, OptionValueResult>();

    constructor(private readonly assoc: SearchAssociationLike) {
        super();
    }

    setOptions(options: ObjectItem[]): void {
        this.options = [...options];
    }

    /**
     * Enables/disables attribute-match mode. Passing `undefined` returns the
     * store to plain association filtering.
     */
    setMatchConfig(config: ReferenceMatchConfig | undefined): void {
        this.matchConfig = config;
    }

    setIds(ids: string[]): void {
        this.ids = [...ids];
    }

    toggleId(id: string): void {
        this.ids = this.ids.includes(id) ? this.ids.filter(x => x !== id) : [...this.ids, id];
    }

    /**
     * Picked ids whose match value cannot be resolved yet: no cached value
     * and no currently available option value. The component uses this to
     * re-sync the filter once the options data source delivers the values.
     */
    unresolvedIds(): string[] {
        const match = this.matchConfig;
        if (!match || !match.filterable || this.ids.length === 0) {
            return [];
        }
        const byId = new Map(this.options.map(item => [String(item.id), item]));
        return this.ids.filter(id => {
            if (this.valueCache.has(id)) {
                return false;
            }
            const obj = byId.get(id);
            if (!obj) {
                return true;
            }
            return readOptionValue(match.optionAttribute, obj, match.attributeType).kind === "unavailable";
        });
    }

    get condition(): BuiltCondition | undefined {
        if (this.matchConfig) {
            return this.matchCondition;
        }
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

    /**
     * Attribute-match condition: `equals(gridAttribute, literal(optionValue))`
     * per picked option, combined with `or`. The comparison value is read
     * from the option-side attribute of each picked object; numerics are
     * wrapped in `Big` because the filter builders require it. An empty
     * option value becomes `equals(gridAttribute, empty())`, so only grid
     * rows with an empty attribute match — a valued row never matches an
     * empty option.
     *
     * A pick whose match value cannot be resolved at all (option object not
     * in the options snapshot, or its value withheld by entity access —
     * `status` stays "unavailable" forever) contributes an always-false
     * condition (`attr = empty AND NOT attr = empty`). The user explicitly
     * picked that option, so the filter must stay active and match nothing
     * rather than silently widening to every row while the value is
     * undeliverable.
     */
    private get matchCondition(): BuiltCondition | undefined {
        const match = this.matchConfig;
        if (!match || !match.filterable || this.ids.length === 0) {
            return undefined;
        }
        const expr = attribute(match.attributeId as AttrId);
        const byId = new Map(this.options.map(item => [String(item.id), item]));
        const conditions: BuiltCondition[] = [];
        for (const id of this.ids) {
            const obj = byId.get(id);
            let result: OptionValueResult | undefined;
            if (obj) {
                result = readOptionValue(match.optionAttribute, obj, match.attributeType);
                if (result.kind !== "unavailable") {
                    this.valueCache.set(id, result);
                }
            }
            // While the live value is unavailable (option object not loaded
            // yet or its attributes still loading), fall back to the last
            // known value so a data source reload cannot drop the filter.
            if (!result || result.kind === "unavailable") {
                result = this.valueCache.get(id);
            }
            if (!result) {
                // Unresolvable pick (object absent or value blocked by
                // entity access): keep the filter active but matching
                // nothing — never widen to all rows.
                conditions.push(and(equals(expr, empty()), not(equals(expr, empty()))));
                continue;
            }
            if (result.kind === "empty") {
                conditions.push(equals(expr, empty()));
            } else if (result.kind === "value") {
                conditions.push(equals(expr, literal(result.value)));
            }
        }
        if (conditions.length === 0) {
            return undefined;
        }
        return conditions.length === 1 ? conditions[0] : or(...conditions);
    }

    toJSON(): SerializedFilter | null {
        if (this.ids.length === 0) {
            return null;
        }
        // Match mode is serialized with its own tag so a restored filter
        // re-enters the same condition branch even before options load.
        return this.matchConfig ? ["refmatch", this.assoc.id, [...this.ids]] : ["ref", this.assoc.id, [...this.ids]];
    }

    protected deserialize(data: unknown): SerializedFilter | null {
        if (!Array.isArray(data) || data[1] !== this.assoc.id || !Array.isArray(data[2])) {
            return null;
        }
        const ids = data[2].filter((v): v is string => typeof v === "string");
        if (data[0] === "ref") {
            return ["ref", this.assoc.id, ids];
        }
        if (data[0] === "refmatch") {
            return ["refmatch", this.assoc.id, ids];
        }
        return null;
    }

    protected apply(next: SerializedFilter | null): void {
        this.ids = next && (next[0] === "ref" || next[0] === "refmatch") ? [...next[2]] : [];
    }
}

/**
 * Outcome of reading an option's match-attribute value.
 *
 * - `unavailable`: the value has not been delivered yet — no condition can
 *   be built for this option.
 * - `empty`: the value is null/empty — matches grid rows whose attribute is
 *   empty as well (`equals(attr, empty())`).
 * - `value`: a comparable literal, coerced to the type the filter builders
 *   expect for the grid-side attribute type (numerics wrapped in `Big`).
 */
type OptionValueResult =
    | { kind: "unavailable" }
    | { kind: "empty" }
    | { kind: "value"; value: string | boolean | Date | Big };

function readOptionValue(source: OptionValueSource, item: ObjectItem, attributeType: string): OptionValueResult {
    const value = source.get(item);
    if (value.status !== "available") {
        return { kind: "unavailable" };
    }
    const raw = value.value;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.length === 0)) {
        return { kind: "empty" };
    }
    if (NUMERIC_TYPES.has(attributeType)) {
        return { kind: "value", value: new Big(String(raw)) };
    }
    return { kind: "value", value: raw as string | boolean | Date | Big };
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

/**
 * Builds combo box options from the options data source items. The caption
 * prefers the per-item text template (attribute concatenation such as
 * `{1} - {2}`) and falls back to the caption attribute, then an empty
 * string — never the raw object id.
 */
export function getReferenceOptions(
    items: ObjectItem[] | undefined,
    captionSource: OptionCaptionSource | undefined,
    templateSource?: OptionTemplateSource
): ReferenceOption[] {
    if (!items) {
        return [];
    }
    return items.map(item => ({
        id: item.id,
        caption: optionCaption(item, captionSource, templateSource)
    }));
}

/** Resolves the caption of one option object: template → attribute → empty. */
function optionCaption(
    item: ObjectItem,
    captionSource: OptionCaptionSource | undefined,
    templateSource?: OptionTemplateSource
): string {
    if (templateSource) {
        const dynamic = templateSource.get(item);
        if (dynamic.status === "available" && dynamic.value !== undefined && dynamic.value.trim().length > 0) {
            return dynamic.value;
        }
    }
    if (captionSource) {
        const caption = captionSource.get(item).displayValue;
        if (caption && caption.length > 0) {
            return caption;
        }
    }
    // The caption is null/empty in the database: render an empty label
    // instead of the raw object id.
    return "";
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
 *
 * When the host already holds a condition snapshot identical to the store's
 * current one, re-registration is skipped entirely. Unobserving momentarily
 * removes the store from the host, which pushes `undefined` into the grid
 * and starts an UNFILTERED reload; re-observing then pushes the condition
 * back. If that condition is structurally identical to the one the grid
 * already applied (e.g. switching between two options that both map to
 * `equals(attr, empty())`), the datasource deduplicates the re-push and the
 * unfiltered request wins the race — the grid ends up showing unfiltered
 * rows while the widget believes the filter is active. Skipping the cycle
 * when nothing changed avoids the blip altogether.
 *
 * The host keeps its snapshots in a mobx observable map (`_state`), which is
 * not a native `Map`, so the surface is duck-typed instead.
 */
export function syncFilter(observer: ObservableFilterHost, key: string, store: BaseFilterStore): void {
    const hostState = (
        observer as unknown as {
            _state?: { has?: (k: string) => boolean; get?: (k: string) => unknown };
        }
    )._state;
    const current = store.condition;
    if (hostState && typeof hostState.has === "function" && typeof hostState.get === "function" && hostState.has(key)) {
        const held = hostState.get(key);
        const same = held === undefined ? current === undefined : JSON.stringify(held) === JSON.stringify(current);
        if (same) {
            return;
        }
    }
    store.suppressed = true;
    try {
        observer.unobserve(key);
        observer.observe(key, store);
    } finally {
        store.suppressed = false;
    }
}

/**
 * Pending deferred unobserve, keyed by observer instance. The component
 * defers its unmount cleanup by one tick (see `deferredUnsync`); a widget
 * instance that remounts under the same host must be able to cancel the
 * pending cleanup of the previous instance, so the bookkeeping lives at
 * module level instead of in component refs.
 */
const pendingUnsyncs = new WeakMap<ObservableFilterHost, number>();

/**
 * Schedules the removal of a store registration one tick in the future.
 * The registration effect runs on EVERY render (no dependency array), so an
 * immediate unobserve in its cleanup would fire on every re-render —
 * momentarily removing each condition from the host, pushing `undefined`
 * into the grid and starting an unfiltered reload that can win the race
 * against the re-observed condition (see `syncFilter`). The next effect run
 * cancels the pending cleanup via `cancelDeferredUnsync`, so only a genuine
 * unmount ever unobserves.
 */
export function deferredUnsync(observer: ObservableFilterHost, keys: string[]): void {
    cancelDeferredUnsync(observer);
    const handle = window.setTimeout(() => {
        pendingUnsyncs.delete(observer);
        try {
            for (const key of keys) {
                observer.unobserve(key);
            }
        } catch {
            // The host may already be gone (page/navigation teardown);
            // nothing to clean up in that case.
        }
    }, 0);
    pendingUnsyncs.set(observer, handle);
}

/** Cancels a pending deferred unobserve (called at the start of each effect run). */
export function cancelDeferredUnsync(observer: ObservableFilterHost): void {
    const handle = pendingUnsyncs.get(observer);
    if (handle !== undefined) {
        window.clearTimeout(handle);
        pendingUnsyncs.delete(observer);
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

/** First millisecond of the calendar day (local time). */
function dayStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Last millisecond of the calendar day, so late-day times stay in range. */
function dayEnd(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}
