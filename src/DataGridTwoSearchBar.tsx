import { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import classNames from "classnames";
import { association, equals, literal } from "mendix/filters/builders";
import type { ObjectItem } from "mendix";

import { DataGridTwoSearchBarContainerProps, SearchFieldsType } from "../typings/DataGridTwoSearchBarProps";
import { Alert } from "./components/Alert";
import { entityOfGuid, getDomainGraph } from "./filtering/entity-meta";
import { useFilterAPI } from "./filtering/global-context";
import {
    BaseFilterStore,
    createAttributeStore,
    DateFilterStore,
    getReferenceOptions,
    getUniverseOptions,
    ReferenceFilterStore,
    SelectFilterStore,
    syncFilter,
    TextFilterStore,
    unsyncFilter
} from "./filtering/stores";
import "./ui/DataGridTwoSearchBar.css";

type FieldConfig = SearchFieldsType;

/** Branded association id type expected by the filter builders. */
type AssocId = Parameters<typeof association>[0];

interface FieldEntry {
    key: string;
    config: FieldConfig;
    store: BaseFilterStore;
}

/** Resolves the caption text of a textTemplate prop. */
function templateText(value: { value?: string } | undefined, fallback: string): string {
    const text = value?.value;
    return text && text.trim().length > 0 ? text : fallback;
}

/** Per-id memo of entities resolved through the session metadata. */
const selectionEntityCache = new Map<string, string | undefined>();

/**
 * Resolves the entity name behind an option/selection object id. Purely
 * synchronous: the top 16 bits of a Mendix object id encode the numeric
 * entity id, which maps to the entity name via the session metadata.
 */
function entityOfSelection(selection: ObjectItem): string | undefined {
    const id = String(selection.id);
    if (selectionEntityCache.has(id)) {
        return selectionEntityCache.get(id);
    }
    const entity = entityOfGuid(id);
    selectionEntityCache.set(id, entity);
    return entity;
}

export function DataGridTwoSearchBar(props: DataGridTwoSearchBarContainerProps): ReactElement {
    const { api, error } = useFilterAPI();
    const observer = api?.filterObserver ?? null;

    // One store per configured field. The grid re-renders this widget with
    // a NEW `searchFields` array identity on every parent render (its props
    // are rebuilt from the data source context), so keying the memo on that
    // prop would recreate every store — and wipe all user selections —
    // whenever the grid refreshes (e.g. right after a filter is applied).
    // Keying on `props.name` alone keeps stores stable for the widget's
    // lifetime; field configs are refreshed into the existing stores below.
    const previousFields = useRef<FieldEntry[]>([]);
    const fields = useMemo<FieldEntry[]>(() => {
        const previous = previousFields.current;
        return props.searchFields.map((config, index) => {
            const key = `${props.name}#${index}`;
            const old = previous.find(entry => entry.key === key);
            if (old && old.config.fieldSource === config.fieldSource) {
                // Keep the live store and its state; just refresh config.
                return { ...old, config };
            }
            return { key, config, store: createStore(config) };
        });
    }, [props.searchFields, props.name]);
    useEffect(() => {
        previousFields.current = fields;
    });

    // Register every store with the grid's filter host. Re-registration on
    // each render keeps the host's view of `condition` in sync with our plain
    // (non-reactive) stores; the suppression flag prevents the synchronous
    // personalization replay inside observe() from overwriting fresh state.
    useEffect(() => {
        if (!observer) {
            return undefined;
        }
        for (const { key, store } of fields) {
            syncFilter(observer, key, store);
        }
        return () => {
            for (const { key } of fields) {
                unsyncFilter(observer, key);
            }
        };
    });

    // Reference filters need the REAL option objects to build valid filter
    // literals; keep the store's options in sync with the data source items.
    useEffect(() => {
        for (const { config, store } of fields) {
            if (store instanceof ReferenceFilterStore) {
                store.setOptions(config.optionsDs?.items ?? []);
            }
        }
    });

    // Cascading options for association combo boxes.
    //
    // Runtime container props expose associations as opaque ids
    // (`{ id, filterable }`) — the design-time entity paths are not
    // available, so parent/child relationships are derived from the
    // client-side domain model instead:
    //
    // 1. The full reference graph is read synchronously from the session
    //    metadata (`mx.session.sessionData.metadata`): every entity maps to
    //    the target entities of its reference attributes (District →
    //    Province, Subdistrict → District).
    // 2. For a child field with `optionsParentAssoc`, a candidate parent
    //    field drives it when the child's options entity can reach the
    //    parent's selection entity through exactly one reference hop
    //    (direct-parent rule: the configured association filters that hop,
    //    so a province selection cannot drive a subdistrict list directly).
    // 3. While no applicable parent has a selection, the child's data source
    //    is limited to zero items so the dropdown shows nothing instead of
    //    the full unfiltered list.
    const appliedCascades = useRef<Map<string, string>>(new Map());
    // Remembers each cascade child's options entity across apply cycles so
    // the graph can still be evaluated while the data source is limited to
    // zero items (no options available to sample).
    const lastOptionsEntity = useRef<Map<string, string>>(new Map());

    /**
     * Clones a driver object and neutralizes its hidden data source id.
     * Mendix's `equals()` throws when a literal's data source id differs
     * from the association's — but an *absent* (undefined) id skips that
     * check entirely, while the literal still carries the object's GUID,
     * which is what the server resolves the filter by. This lets a
     * province selection drive a district list built from another data
     * source without tripping the same-data-source assertion.
     */
    const restampForDataSource = (driver: ObjectItem): ObjectItem => {
        const clone = Object.create(Object.getPrototypeOf(driver));
        Object.assign(clone, driver);
        for (const sym of Object.getOwnPropertySymbols(driver)) {
            if (sym.toString() === "Symbol(dataSourceId)") {
                Object.defineProperty(clone, sym, {
                    value: undefined,
                    writable: true,
                    enumerable: false,
                    configurable: true
                });
            }
        }
        return clone;
    };

    useEffect(() => {
        // The cascade must never crash the widget: filter-builder assertions
        // throw synchronously, and an uncaught error would blank the whole
        // search bar. Log and bail out instead.
        try {
            return applyCascades();
        } catch (err) {
            console.error("[DataGridTwoSearchBar] cascade error", err);
            return undefined;
        }

        function applyCascades(): void | undefined {
            interface CascadeField {
                key: string;
                config: FieldConfig;
                store: ReferenceFilterStore;
                ds: NonNullable<FieldConfig["optionsDs"]>;
            }

            const cascadeFields: CascadeField[] = [];
            for (const { config, store } of fields) {
                if (config.optionsParentAssoc && config.optionsDs && store instanceof ReferenceFilterStore) {
                    cascadeFields.push({ key: config.association.id, config, store, ds: config.optionsDs });
                }
            }
            if (cascadeFields.length === 0) {
                return undefined;
            }

            // Collect selections of all association fields — these are the
            // candidate cascade drivers.
            const selections = new Map<string, ObjectItem>();
            for (const { config, store } of fields) {
                if (config.fieldSource === "association" && store instanceof ReferenceFilterStore && store.ids[0]) {
                    const obj = store.options.find(item => String(item.id) === store.ids[0]);
                    if (obj) {
                        selections.set(config.association.id, obj);
                    }
                }
            }

            // Synchronous reference graph from the client-side domain model — no
            // GUID lookups needed, so cascades work even while a child's data
            // source is limited to zero items.
            const domainGraph = getDomainGraph();
            if (domainGraph.size === 0) {
                return undefined;
            }
            const graph = new Map<string, Set<string>>();
            for (const meta of domainGraph.values()) {
                let targets = graph.get(meta.entity);
                if (!targets) {
                    targets = new Set();
                    graph.set(meta.entity, targets);
                }
                for (const ref of meta.refs) {
                    targets.add(ref);
                }
            }

            // Shortest reference-hop distance between two entities.
            const distance = (from: string, to: string): number => {
                if (from === to) {
                    return 0;
                }
                const visited = new Set([from]);
                let frontier = [from];
                let depth = 0;
                while (frontier.length > 0) {
                    depth += 1;
                    const next: string[] = [];
                    for (const node of frontier) {
                        for (const target of graph.get(node) ?? []) {
                            if (target === to) {
                                return depth;
                            }
                            if (!visited.has(target)) {
                                visited.add(target);
                                next.push(target);
                            }
                        }
                    }
                    frontier = next;
                }
                return Number.POSITIVE_INFINITY;
            };

            for (const field of cascadeFields) {
                // The child's options entity: remembered from an earlier apply
                // cycle when available (the data source may currently be limited
                // to zero items), else sampled from a live option object. The
                // sample resolves asynchronously; the next apply cycle (any
                // re-render) picks up the memoized result.
                let optionsEntity = lastOptionsEntity.current.get(field.key);
                if (!optionsEntity && field.store.options.length > 0) {
                    optionsEntity = entityOfSelection(field.store.options[0]);
                }
                if (!optionsEntity) {
                    continue;
                }
                lastOptionsEntity.current.set(field.key, optionsEntity);

                // Nearest ancestor with a selection becomes the driver. Only
                // DIRECT parents (one reference hop) are usable: the configured
                // parent association filters that hop, so a selection further up
                // the chain (e.g. a province for a subdistrict list) cannot be
                // expressed as a single equals() condition.
                let best: { guid: string; dist: number } | undefined;
                for (const selection of selections.values()) {
                    const selEntity = entityOfSelection(selection);
                    if (!selEntity || selEntity === optionsEntity) {
                        continue;
                    }
                    const dist = distance(optionsEntity, selEntity);
                    if (dist === 1 && (!best || dist < best.dist)) {
                        best = { guid: String(selection.id), dist };
                    }
                }

                const signature = best ? best.guid : "";
                if (appliedCascades.current.get(field.key) === signature) {
                    continue;
                }
                appliedCascades.current.set(field.key, signature);
                if (best) {
                    const driver = [...selections.values()].find(obj => String(obj.id) === best.guid);
                    if (driver) {
                        field.ds.setLimit(undefined);
                        field.ds.setFilter(
                            equals(
                                association(field.config.optionsParentAssoc!.id as AssocId),
                                literal(restampForDataSource(driver))
                            )
                        );
                        continue;
                    }
                }
                // No applicable parent selection: show no options at all.
                field.ds.setFilter(undefined);
                field.ds.setLimit(0);
            }

            return undefined;
        }
    });

    const clearAll = useCallback(() => {
        for (const { store } of fields) {
            store.reset();
        }
        if (observer) {
            for (const { key, store } of fields) {
                syncFilter(observer, key, store);
            }
        }
    }, [fields, observer]);

    const hasFields = fields.length > 0;

    // Plain (non-reactive) stores do not trigger re-renders; keep a version
    // counter that mutators bump so controlled inputs stay editable.
    const [, setVersion] = useState(0);
    const bump = useCallback(() => setVersion(v => v + 1), []);

    return (
        <div className={classNames("widget-dg2-searchbar", "mx-layoutgrid mx-layoutgrid-fluid", props.class)}>
            {error ? (
                <Alert bootstrapStyle="warning" message={error.message} className="widget-dg2-searchbar__alert" />
            ) : null}
            {!error && !hasFields ? (
                <Alert
                    bootstrapStyle="info"
                    message="No search fields configured."
                    className="widget-dg2-searchbar__alert"
                />
            ) : null}
            {hasFields ? (
                <div className="widget-dg2-searchbar__row form-horizontal">
                    {fields.map(({ key, config, store }) => (
                        <SearchFieldControl
                            key={key}
                            config={config}
                            store={store}
                            selectPageAction={props.selectPageAction}
                            onChange={bump}
                        />
                    ))}
                    <div className="widget-dg2-searchbar__cell widget-dg2-searchbar__cell--actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                                clearAll();
                                bump();
                            }}
                        >
                            {templateText(props.clearButtonCaption, "Clear")}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

interface SearchFieldControlProps {
    config: FieldConfig;
    store: BaseFilterStore;
    selectPageAction?: DataGridTwoSearchBarContainerProps["selectPageAction"];
    onChange: () => void;
}

function SearchFieldControl({
    config,
    store,
    selectPageAction,
    onChange
}: SearchFieldControlProps): ReactElement | null {
    const caption = templateText(config.caption, "Search");
    const placeholder = config.placeholder?.value || "";

    switch (config.controlType) {
        case "combobox":
            return (
                <ComboBoxField
                    caption={caption}
                    placeholder={placeholder}
                    config={config}
                    store={store}
                    onChange={onChange}
                />
            );
        case "datepicker":
            return <DateField caption={caption} store={store} onChange={onChange} />;
        case "selectpage":
            return <SelectPageField caption={caption} config={config} selectPageAction={selectPageAction} />;
        case "textbox":
        default:
            return <TextField caption={caption} placeholder={placeholder} store={store} onChange={onChange} />;
    }
}

function TextField({
    caption,
    placeholder,
    store,
    onChange
}: {
    caption: string;
    placeholder: string;
    store: BaseFilterStore;
    onChange: () => void;
}): ReactElement {
    const textStore = store instanceof TextFilterStore ? store : null;
    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label" htmlFor={`sb-${storeKey(store)}`}>
                {caption}
            </label>
            <input
                id={`sb-${storeKey(store)}`}
                type="text"
                className="form-control"
                value={textStore?.text ?? ""}
                placeholder={placeholder}
                onChange={event => {
                    textStore?.setText(event.target.value);
                    onChange();
                }}
            />
        </div>
    );
}

function ComboBoxField({
    caption,
    placeholder,
    config,
    store,
    onChange
}: {
    caption: string;
    placeholder: string;
    config: FieldConfig;
    store: BaseFilterStore;
    onChange: () => void;
}): ReactElement {
    const isReference = config.fieldSource === "association";
    const options = useMemo(
        () =>
            isReference
                ? getReferenceOptions(config.optionsDs?.items, config.captionAttribute)
                : getUniverseOptions(config.attribute),
        [isReference, config.optionsDs?.items, config.captionAttribute, config.attribute]
    );

    let selected = "";
    if (store instanceof SelectFilterStore) {
        selected = store.values.join(",");
    } else if (store instanceof ReferenceFilterStore) {
        selected = store.ids.join(",");
    }

    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label" htmlFor={`sb-${storeKey(store)}`}>
                {caption}
            </label>
            <select
                id={`sb-${storeKey(store)}`}
                className="form-control"
                value={selected}
                onChange={event => {
                    const { value } = event.target;
                    if (store instanceof SelectFilterStore) {
                        store.setValues(value ? value.split(",") : []);
                    } else if (store instanceof ReferenceFilterStore) {
                        store.setIds(value ? [value] : []);
                    }
                    onChange();
                }}
            >
                <option value="">{placeholder || "-- all --"}</option>
                {options.map(option => {
                    const value = "id" in option ? option.id : option.value;
                    return (
                        <option key={`${value}-${option.caption}`} value={value}>
                            {option.caption}
                        </option>
                    );
                })}
            </select>
        </div>
    );
}

function DateField({
    caption,
    store,
    onChange
}: {
    caption: string;
    store: BaseFilterStore;
    onChange: () => void;
}): ReactElement {
    const dateStore = store instanceof DateFilterStore ? store : null;
    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label" htmlFor={`sb-${storeKey(store)}`}>
                {caption}
            </label>
            <input
                id={`sb-${storeKey(store)}`}
                type="date"
                className="form-control"
                value={dateStore?.date ?? ""}
                onChange={event => {
                    dateStore?.setDate(event.target.value);
                    onChange();
                }}
            />
        </div>
    );
}

function SelectPageField({
    caption,
    config,
    selectPageAction
}: {
    caption: string;
    config: FieldConfig;
    selectPageAction?: DataGridTwoSearchBarContainerProps["selectPageAction"];
}): ReactElement {
    const handleClick = useCallback(() => {
        const item = config.optionsDs?.items?.[0];
        if (item) {
            selectPageAction?.execute();
        }
    }, [config.optionsDs, selectPageAction]);

    return (
        <div className="widget-dg2-searchbar__cell">
            <span className="widget-dg2-searchbar__label control-label">{caption}</span>
            <button type="button" className="btn btn-default widget-dg2-searchbar__select-page" onClick={handleClick}>
                Select…
            </button>
        </div>
    );
}

function storeKey(store: BaseFilterStore): string {
    return String(store.constructor.name || "field").toLowerCase();
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/** Creates the filter store matching a field's source and control type. */
function createStore(config: FieldConfig): BaseFilterStore {
    if (config.fieldSource === "association") {
        // Association fields have no attribute configured; the reference
        // type (Reference vs ReferenceSet) is probed inside the store.
        return new ReferenceFilterStore({
            id: config.association.id,
            filterable: config.association.filterable
        });
    }
    return createAttributeStore({
        id: config.attribute.id,
        filterable: config.attribute.filterable,
        type: config.attribute.type,
        universe: config.attribute.universe,
        formatter: { format: (value?: unknown) => formatUniverseValue(config.attribute, value) }
    });
}

function formatUniverseValue(attr: FieldConfig["attribute"], value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }
    if (attr.type === "Boolean") {
        return value === true ? "True" : "False";
    }
    if (attr.type === "Enum") {
        // Enum universes contain the raw enum keys; display them readably.
        return String(value).replace(/_/g, " ");
    }
    return String(value);
}
