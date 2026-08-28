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
    if (text && text.trim().length > 0) {
        // Pages created before the button was renamed still carry the old
        // default caption in their model; show the new caption instead.
        return text.trim() === "Clear" ? fallback : text;
    }
    return fallback;
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
    // In deferred mode (searchOnButtonClick) this registration is skipped so
    // the grid never sees draft edits until the Search button is pressed.
    useEffect(() => {
        if (!observer || props.searchOnButtonClick) {
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
    // A changed items identity (e.g. the reload issued after a select-page
    // pick) also bumps the version so syncFilter re-reads the conditions
    // with the fresh options in the following render.
    const lastOptionsItems = useRef<Map<string, unknown>>(new Map());
    useEffect(() => {
        let changed = false;
        for (const { key, config, store } of fields) {
            if (store instanceof ReferenceFilterStore) {
                // Compare the RAW items reference: `?? []` would mint a new
                // array identity on every render while the data source is
                // still loading (items undefined), making this effect see a
                // "change" each pass — bump() re-renders, the effect runs
                // again, and React aborts with "Maximum update depth
                // exceeded". Only a real items identity change may bump.
                const rawItems = config.optionsDs?.items;
                if (lastOptionsItems.current.get(key) !== rawItems) {
                    lastOptionsItems.current.set(key, rawItems);
                    store.setOptions(rawItems ?? []);
                    changed = true;
                }
            }
        }
        if (changed) {
            bump();
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
                // No applicable parent selection: hide everything (default —
                // strict cascade, the user must pick a parent first) or leave
                // the full option list available for direct filtering.
                field.ds.setFilter(undefined);
                if (field.config.cascadeEmptyBehavior === "showall") {
                    field.ds.setLimit(undefined);
                } else {
                    field.ds.setLimit(0);
                }
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

    /**
     * Deferred mode: push every field's current condition to the grid in one
     * go. Called from the Search button only — while deferred, individual
     * edits never reach the grid.
     */
    const applySearch = useCallback(() => {
        if (!observer) {
            return;
        }
        for (const { key, store } of fields) {
            syncFilter(observer, key, store);
        }
    }, [fields, observer]);

    const hasFields = fields.length > 0;

    // Plain (non-reactive) stores do not trigger re-renders; keep a version
    // counter that mutators bump so controlled inputs stay editable.
    const [, setVersion] = useState(0);
    const bump = useCallback(() => setVersion(v => v + 1), []);

    // The Filter button collapses/expands the whole search-fields area.
    // The initial state comes from the "Show fields by default" property;
    // hiding plays a short close animation first (see lv2-close in the CSS)
    // and only then unmounts the fields; showing mounts them immediately so
    // the open animation (lv2-open) runs on the freshly mounted container.
    const [fieldsVisible, setFieldsVisible] = useState(props.defaultShowFields !== false);
    const [fieldsClosing, setFieldsClosing] = useState(false);
    const closeTimer = useRef<number | undefined>(undefined);
    const toggleFields = useCallback(() => {
        if (closeTimer.current !== undefined) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = undefined;
        }
        if (fieldsVisible) {
            setFieldsClosing(true);
            closeTimer.current = window.setTimeout(() => {
                closeTimer.current = undefined;
                setFieldsVisible(false);
                setFieldsClosing(false);
            }, 260);
        } else {
            setFieldsVisible(true);
        }
    }, [fieldsVisible]);
    useEffect(
        () => () => {
            if (closeTimer.current !== undefined) {
                window.clearTimeout(closeTimer.current);
            }
        },
        []
    );

    // Maximum number of search controls on one row; the rest wrap onto new
    // row divs. Guard against zero/negative values.
    const perRow = Math.max(1, props.fieldsPerRow || 5);
    const fieldRows: Array<Array<{ key: string; config: FieldConfig; store: BaseFilterStore }>> = [];
    for (let i = 0; i < fields.length; i += perRow) {
        fieldRows.push(fields.slice(i, i + perRow));
    }

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
            {hasFields && fieldsVisible ? (
                <div
                    className={classNames(
                        "widget-dg2-searchbar__fields",
                        fieldsClosing && "widget-dg2-searchbar__fields--closing"
                    )}
                >
                    {fieldRows.map((rowFields, rowIndex) => (
                        <div key={rowIndex} className="widget-dg2-searchbar__row form-horizontal">
                            {rowFields.map(({ key, config, store }) => (
                                <SearchFieldControl
                                    key={key}
                                    config={config}
                                    store={store}
                                    selectPageAction={props.selectPageAction}
                                    allOptionsCaptionDefault={templateText(props.allOptionsCaptionDefault, "-- all --")}
                                    onChange={bump}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            ) : null}
            {hasFields ? (
                <div className="widget-dg2-searchbar__actions-row">
                    <div className="widget-dg2-searchbar__actions-left">
                        {props.showFilterButton !== false ? (
                            <button
                                type="button"
                                className="btn btn-default"
                                aria-expanded={fieldsVisible}
                                onClick={toggleFields}
                            >
                                {templateText(props.filterButtonCaption, "Filter")}
                            </button>
                        ) : null}
                        {props.customButtons?.map((button, index) => {
                            const caption = templateText(button.caption, `Button ${index + 1}`);
                            const styleClass = `btn btn-${button.buttonStyle}`;
                            if (button.buttonAction === "togglefilter") {
                                return (
                                    <button
                                        key={index}
                                        type="button"
                                        className={styleClass}
                                        aria-expanded={fieldsVisible}
                                        onClick={toggleFields}
                                    >
                                        {caption}
                                    </button>
                                );
                            }
                            const action = button.onClickAction;
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    className={styleClass}
                                    disabled={!action?.canExecute || action?.isExecuting}
                                    onClick={() => action?.execute()}
                                >
                                    {caption}
                                </button>
                            );
                        })}
                    </div>
                    <div className="widget-dg2-searchbar__actions-right">
                        {props.searchOnButtonClick && props.showSearchButton !== false ? (
                            <button type="button" className="btn btn-primary" onClick={applySearch}>
                                {templateText(props.searchButtonCaption, "Search")}
                            </button>
                        ) : null}
                        {props.showClearButton !== false ? (
                            <button
                                type="button"
                                className="btn btn-default"
                                onClick={() => {
                                    clearAll();
                                    bump();
                                }}
                            >
                                {templateText(props.clearButtonCaption, "Reset")}
                            </button>
                        ) : null}
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
    allOptionsCaptionDefault: string;
    onChange: () => void;
}

function SearchFieldControl({
    config,
    store,
    selectPageAction,
    allOptionsCaptionDefault,
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
                    allOptionsCaption={templateText(config.allOptionsCaption, allOptionsCaptionDefault || "-- all --")}
                    config={config}
                    store={store}
                    onChange={onChange}
                />
            );
        case "datepicker":
            return (
                <DateField
                    caption={caption}
                    placeholder={placeholder}
                    config={config}
                    store={store}
                    onChange={onChange}
                />
            );
        case "selectpage":
            return (
                <SelectPageField
                    caption={caption}
                    placeholder={placeholder}
                    config={config}
                    store={store}
                    selectPageAction={config.selectPageAction ?? selectPageAction}
                    onChange={onChange}
                />
            );
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
    allOptionsCaption,
    config,
    store,
    onChange
}: {
    caption: string;
    placeholder: string;
    allOptionsCaption: string;
    config: FieldConfig;
    store: BaseFilterStore;
    onChange: () => void;
}): ReactElement {
    const isReference = config.fieldSource === "association";
    const allOptions = useMemo(
        () =>
            isReference
                ? getReferenceOptions(config.optionsDs?.items, config.captionAttribute)
                : getUniverseOptions(config.attribute),
        [isReference, config.optionsDs?.items, config.captionAttribute, config.attribute]
    );

    // Type-to-filter state. The input doubles as the control and the search
    // box; typing narrows the rendered options without touching the filter.
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Close the dropdown when clicking/tabling outside of it.
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        const onPointerDown = (event: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [open]);

    let selected = "";
    if (store instanceof SelectFilterStore) {
        selected = store.values.join(",");
    } else if (store instanceof ReferenceFilterStore) {
        selected = store.ids.join(",");
    }

    // Caption of the currently selected option — shown in the closed input.
    const selectedCaption = useMemo(() => {
        if (!selected) {
            return "";
        }
        const ids = selected.split(",");
        return allOptions.find(option => ids.includes("id" in option ? option.id : option.value))?.caption ?? "";
    }, [selected, allOptions]);

    // Case-insensitive substring match over captions; then cap the list at
    // `optionsLimit` entries so huge option sets stay usable.
    const limit = Math.max(1, config.optionsLimit || 100);
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const matched = q ? allOptions.filter(option => option.caption.toLowerCase().includes(q)) : allOptions;
        return matched.slice(0, limit);
    }, [allOptions, query, limit]);

    // Lazy loading (reference fields only): the options data source is
    // paged with setOffset/setLimit and the next page is requested when the
    // dropdown is scrolled to the bottom. The data source keeps the loaded
    // pages in `items`, so options accumulate across pages.
    const ds = config.optionsDs;
    const lazy = isReference && config.optionsLazyLoad === true && !!ds;
    const pageSize = Math.max(1, config.optionsPageSize || 50);
    const [loadingMore, setLoadingMore] = useState(false);
    const lastPagedOffset = useRef<number | null>(null);

    // Keep the page size in sync with the property; a changed size invalidates
    // the paging bookkeeping so the next scroll request starts from the
    // current item count.
    useEffect(() => {
        if (lazy && ds && ds.limit !== pageSize) {
            ds.setLimit(pageSize);
            lastPagedOffset.current = null;
        }
    });

    const loadMore = useCallback(() => {
        if (!lazy || !ds || loadingMore) {
            return;
        }
        if (ds.hasMoreItems === false) {
            return;
        }
        const nextOffset = ds.offset + (ds.items?.length ?? 0);
        if (nextOffset === lastPagedOffset.current) {
            return;
        }
        lastPagedOffset.current = nextOffset;
        setLoadingMore(true);
        ds.setOffset(nextOffset);
    }, [lazy, ds, loadingMore, pageSize]);

    // Clear the loading flag when the requested page arrives (items identity
    // changes) or when the data source reports no more items.
    const lastItemsRef = useRef(ds?.items);
    useEffect(() => {
        if (loadingMore && ds && lastItemsRef.current !== ds.items) {
            lastItemsRef.current = ds.items;
            setLoadingMore(false);
        }
    });

    const onListScroll = (event: React.UIEvent<HTMLUListElement>): void => {
        if (!lazy) {
            return;
        }
        const el = event.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
            loadMore();
        }
    };

    const commit = (value: string): void => {
        setQuery("");
        setOpen(false);
        if (store instanceof SelectFilterStore) {
            store.setValues(value ? value.split(",") : []);
        } else if (store instanceof ReferenceFilterStore) {
            store.setIds(value ? [value] : []);
        }
        onChange();
    };

    return (
        <div className="widget-dg2-searchbar__cell" ref={rootRef}>
            <label className="widget-dg2-searchbar__label control-label" htmlFor={`sb-${storeKey(store)}`}>
                {caption}
            </label>
            <div className="widget-dg2-searchbar__combo">
                <input
                    id={`sb-${storeKey(store)}`}
                    type="text"
                    role="combobox"
                    aria-expanded={open}
                    aria-autocomplete="list"
                    className="form-control"
                    autoComplete="off"
                    value={open ? query : selectedCaption}
                    placeholder={placeholder || allOptionsCaption}
                    onChange={event => {
                        setQuery(event.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onClick={() => setOpen(true)}
                    onKeyDown={event => {
                        if (event.key === "Escape") {
                            setOpen(false);
                        }
                    }}
                />
                {selected && !open ? (
                    <button
                        type="button"
                        className="widget-dg2-searchbar__combo-clear"
                        aria-label="Clear selection"
                        tabIndex={-1}
                        onClick={() => commit("")}
                    >
                        ×
                    </button>
                ) : null}
                {/* Dropdown toggle on the RIGHT edge of the control. */}
                <button
                    type="button"
                    className="widget-dg2-searchbar__combo-toggle"
                    aria-label="Open dropdown"
                    aria-expanded={open}
                    tabIndex={-1}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => setOpen(o => !o)}
                >
                    <span aria-hidden="true">▼</span>
                </button>
                {open ? (
                    <ul className="widget-dg2-searchbar__combo-list" role="listbox" onScroll={onListScroll}>
                        <li
                            role="option"
                            aria-selected={!selected}
                            className={
                                "widget-dg2-searchbar__combo-item" +
                                (!selected ? " widget-dg2-searchbar__combo-item--active" : "")
                            }
                            onMouseDown={event => {
                                // mousedown so blur/scroll ordering never eats the click
                                event.preventDefault();
                                commit("");
                            }}
                        >
                            {allOptionsCaption}
                        </li>
                        {filtered.map(option => {
                            const value = "id" in option ? option.id : option.value;
                            const active = selected.split(",").includes(value);
                            return (
                                <li
                                    key={`${value}-${option.caption}`}
                                    role="option"
                                    aria-selected={active}
                                    className={
                                        "widget-dg2-searchbar__combo-item" +
                                        (active ? " widget-dg2-searchbar__combo-item--active" : "")
                                    }
                                    onMouseDown={event => {
                                        event.preventDefault();
                                        commit(value);
                                    }}
                                >
                                    {option.caption}
                                </li>
                            );
                        })}
                        {filtered.length === 0 ? (
                            <li className="widget-dg2-searchbar__combo-item widget-dg2-searchbar__combo-item--empty">
                                No matches
                            </li>
                        ) : null}
                        {lazy && loadingMore ? (
                            <li className="widget-dg2-searchbar__combo-item widget-dg2-searchbar__combo-item--empty">
                                Loading…
                            </li>
                        ) : null}
                        {lazy && !loadingMore && ds.hasMoreItems === false && filtered.length > 0 ? (
                            <li className="widget-dg2-searchbar__combo-item widget-dg2-searchbar__combo-item--empty">
                                All {allOptions.length} options loaded
                            </li>
                        ) : null}
                    </ul>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Compiled token layout of a configured date format such as dd/MM/yyyy.
 * Only the exact tokens dd, MM and yyyy are supported; anything else makes
 * the control fall back to the browser's native date picker.
 */
interface DateFormatSpec {
    test: RegExp;
    order: Array<"d" | "M" | "y">;
}

function compileDateFormat(format: string): DateFormatSpec | undefined {
    const order: Array<"d" | "M" | "y"> = [];
    let pattern = "";
    const tokenPattern = /dd|MM|yyyy|[^dMy]+/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(format)) !== null) {
        if (match[0] === "dd") {
            order.push("d");
            pattern += "(\\d{1,2})";
        } else if (match[0] === "MM") {
            order.push("M");
            pattern += "(\\d{1,2})";
        } else if (match[0] === "yyyy") {
            order.push("y");
            pattern += "(\\d{4})";
        } else {
            pattern += match[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }
    if (order.length !== 3) {
        return undefined;
    }
    return { test: new RegExp(`^${pattern}$`), order };
}

/** Converts user input in the configured format to ISO yyyy-mm-dd ("" if incomplete/invalid). */
function formattedToIso(input: string, spec: DateFormatSpec): string {
    const match = spec.test.exec(input.trim());
    if (!match) {
        return "";
    }
    let day = "";
    let month = "";
    let year = "";
    spec.order.forEach((token, index) => {
        if (token === "d") {
            day = match[index + 1];
        } else if (token === "M") {
            month = match[index + 1];
        } else {
            year = match[index + 1];
        }
    });
    const dayNum = Number(day);
    const monthNum = Number(month);
    if (!year || monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
        return "";
    }
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Renders an ISO yyyy-mm-dd value using the configured token format. */
function isoToFormatted(iso: string, format: string): string {
    const [year, month, day] = iso.split("-");
    return format.replace(/dd/g, day).replace(/MM/g, month).replace(/yyyy/g, year);
}

/**
 * Date filter control.
 *
 * Without a configured format the browser's native `<input type="date">`
 * is used directly. A valid format (e.g. dd/MM/yyyy) switches the visible
 * control to a text box following the token pattern while an invisible
 * native date input stays overlaid on the calendar icon, so the browser
 * picker still opens and its choice is rendered back in the configured
 * format. With `dateRange` enabled two inputs (Date from / Date to) appear
 * and the store filters an inclusive calendar-day range instead of a
 * single day; either bound may be empty.
 */
function DateField({
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
    const dateStore = store instanceof DateFilterStore ? store : null;
    const formatText = config.dateFormat?.value?.trim() ?? "";
    const spec = useMemo(() => (formatText ? compileDateFormat(formatText) : undefined), [formatText]);
    const formatted = !!spec;
    const rangeMode = config.dateRange;

    // Formatted text boxes hold raw drafts locally: partial input ("25/") is
    // not representable as a date, so the store only receives complete,
    // valid ISO values. Native inputs commit their full ISO value directly.
    const [draftSingle, setDraftSingle] = useState("");
    const [draftFrom, setDraftFrom] = useState("");
    const [draftTo, setDraftTo] = useState("");
    const lastCommitted = useRef({ single: "", from: "", to: "" });

    // External store changes (Reset button, personalization replay) resync
    // the drafts; the widget's own commits skip the resync through
    // lastCommitted, which mirrors what was last pushed into the store.
    useEffect(() => {
        const single = dateStore?.date ?? "";
        const from = dateStore?.dateFrom ?? "";
        const to = dateStore?.dateTo ?? "";
        const last = lastCommitted.current;
        if (single !== last.single) {
            last.single = single;
            setDraftSingle(single && formatted ? isoToFormatted(single, formatText) : single);
        }
        if (from !== last.from || to !== last.to) {
            last.from = from;
            last.to = to;
            setDraftFrom(from && formatted ? isoToFormatted(from, formatText) : from);
            setDraftTo(to && formatted ? isoToFormatted(to, formatText) : to);
        }
    });

    const commitSingle = (raw: string): void => {
        if (formatted) {
            setDraftSingle(raw);
        }
        const iso = formatted ? formattedToIso(raw, spec!) : raw;
        lastCommitted.current.single = iso;
        dateStore?.setDate(iso);
        onChange();
    };

    const commitFrom = (raw: string): void => {
        if (formatted) {
            setDraftFrom(raw);
        }
        const iso = formatted ? formattedToIso(raw, spec!) : raw;
        lastCommitted.current.from = iso;
        dateStore?.setDateRange(iso, dateStore?.dateTo ?? "");
        onChange();
    };

    const commitTo = (raw: string): void => {
        if (formatted) {
            setDraftTo(raw);
        }
        const iso = formatted ? formattedToIso(raw, spec!) : raw;
        lastCommitted.current.to = iso;
        dateStore?.setDateRange(dateStore?.dateFrom ?? "", iso);
        onChange();
    };

    // Commits from the native picker overlay: the value arrives as ISO and
    // the visible formatted draft is rendered back from it.
    const commitSingleIso = (iso: string): void => {
        if (formatted) {
            setDraftSingle(iso ? isoToFormatted(iso, formatText) : "");
        }
        lastCommitted.current.single = iso;
        dateStore?.setDate(iso);
        onChange();
    };

    const commitFromIso = (iso: string): void => {
        if (formatted) {
            setDraftFrom(iso ? isoToFormatted(iso, formatText) : "");
        }
        lastCommitted.current.from = iso;
        dateStore?.setDateRange(iso, dateStore?.dateTo ?? "");
        onChange();
    };

    const commitToIso = (iso: string): void => {
        if (formatted) {
            setDraftTo(iso ? isoToFormatted(iso, formatText) : "");
        }
        lastCommitted.current.to = iso;
        dateStore?.setDateRange(dateStore?.dateFrom ?? "", iso);
        onChange();
    };

    // Invisible native date input pinned over the calendar icon: clicking
    // opens the browser picker (showPicker where available, the native
    // indicator click otherwise) while the visible text box keeps the
    // configured format.
    const pickerOverlay = (iso: string, commit: (iso: string) => void, label: string): ReactElement => (
        <>
            <input
                type="date"
                className="widget-dg2-searchbar__date-native"
                aria-label={label}
                tabIndex={-1}
                value={iso}
                onChange={event => commit(event.target.value)}
                onClick={event => {
                    const el = event.currentTarget;
                    if (typeof el.showPicker === "function") {
                        try {
                            el.showPicker();
                        } catch {
                            // Already open or not permitted — the native click still works.
                        }
                    }
                }}
            />
            <span className="widget-dg2-searchbar__date-icon" aria-hidden="true" />
        </>
    );

    const clearAllDates = (): void => {
        lastCommitted.current = { single: "", from: "", to: "" };
        setDraftSingle("");
        setDraftFrom("");
        setDraftTo("");
        dateStore?.setDate("");
        dateStore?.setDateRange("", "");
        onChange();
    };

    const hasValue = !!dateStore && (!!dateStore.date || !!dateStore.dateFrom || !!dateStore.dateTo);

    const singleControl = formatted ? (
        <div className="widget-dg2-searchbar__datewrap">
            <input
                id={`sb-${storeKey(store)}`}
                type="text"
                className="form-control"
                autoComplete="off"
                value={draftSingle}
                placeholder={placeholder || formatText}
                onChange={event => commitSingle(event.target.value)}
            />
            {pickerOverlay(dateStore?.date ?? "", commitSingleIso, `${caption} picker`)}
        </div>
    ) : (
        <input
            id={`sb-${storeKey(store)}`}
            type="date"
            className="form-control"
            value={dateStore?.date ?? ""}
            onChange={event => commitSingle(event.target.value)}
        />
    );

    const fromControl = formatted ? (
        <div className="widget-dg2-searchbar__datewrap">
            <input
                type="text"
                className="form-control"
                autoComplete="off"
                aria-label={`${caption} from`}
                value={draftFrom}
                placeholder={placeholder || formatText}
                onChange={event => commitFrom(event.target.value)}
            />
            {pickerOverlay(dateStore?.dateFrom ?? "", commitFromIso, `${caption} from picker`)}
        </div>
    ) : (
        <input
            type="date"
            className="form-control"
            aria-label={`${caption} from`}
            value={dateStore?.dateFrom ?? ""}
            onChange={event => commitFrom(event.target.value)}
        />
    );

    const toControl = formatted ? (
        <div className="widget-dg2-searchbar__datewrap">
            <input
                type="text"
                className="form-control"
                autoComplete="off"
                aria-label={`${caption} to`}
                value={draftTo}
                placeholder={placeholder || formatText}
                onChange={event => commitTo(event.target.value)}
            />
            {pickerOverlay(dateStore?.dateTo ?? "", commitToIso, `${caption} to picker`)}
        </div>
    ) : (
        <input
            type="date"
            className="form-control"
            aria-label={`${caption} to`}
            value={dateStore?.dateTo ?? ""}
            onChange={event => commitTo(event.target.value)}
        />
    );

    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label" htmlFor={`sb-${storeKey(store)}`}>
                {caption}
            </label>
            <div className="widget-dg2-searchbar__combo">
                {rangeMode ? (
                    <div className="widget-dg2-searchbar__daterange">
                        {fromControl}
                        {toControl}
                    </div>
                ) : (
                    singleControl
                )}
                {hasValue ? (
                    <button
                        type="button"
                        className="widget-dg2-searchbar__combo-clear"
                        aria-label="Clear date"
                        tabIndex={-1}
                        onClick={clearAllDates}
                    >
                        ×
                    </button>
                ) : null}
            </div>
        </div>
    );
}

/** DOM event the select page's pick button dispatches (see SelectPageField). */
const PICK_EVENT = "mx-select-page-pick";

/** Field id of the picker opened most recently; it owns the next pick event. */
let activeOpener: string | null = null;

/**
 * Select page control: a read-only display of the current selection plus a
 * diagonal-arrow button that opens the configured page where the end user
 * picks an object.
 *
 * Selection capture contract (event-based — no helper entity, no database
 * writes): the opened page reports the picked object by dispatching a DOM
 * CustomEvent named "mx-select-page-pick" from a JavaScript action called by
 * its pick button, e.g. a JS action `JS_ReportPick` with one Object
 * parameter `obj` (the clicked row):
 *
 *     export async function JS_ReportPick(obj) {
 *         window.dispatchEvent(new CustomEvent("mx-select-page-pick", {
 *             detail: { guid: obj.getGuid() }
 *         }));
 *         return true;
 *     }
 *
 * wired as: pick button → Call a nanoflow (parameter = row object) → this
 * JS action → (optionally) Close page. The widget resolves the GUID against
 * its Options data source items and applies it to the field's filter; when
 * the object is missing from the current options snapshot the source is
 * reloaded once so caption and filter literal can resolve.
 */
function SelectPageField({
    caption,
    placeholder,
    config,
    store,
    selectPageAction,
    onChange
}: {
    caption: string;
    placeholder: string;
    config: FieldConfig;
    store: BaseFilterStore;
    selectPageAction?: DataGridTwoSearchBarContainerProps["selectPageAction"];
    onChange: () => void;
}): ReactElement {
    const refStore = store instanceof ReferenceFilterStore ? store : null;

    // True between clicking the arrow and receiving the pick event (or the
    // safety timeout). The ref is read inside the DOM listener; the state
    // drives re-renders and the timeout effect below.
    const pendingRef = useRef(false);
    const [pending, setPending] = useState(false);

    // Latest options data source for the pick handler, which must not depend
    // on the prop identity (the grid re-creates it on every render).
    const optionsDsRef = useRef(config.optionsDs);
    optionsDsRef.current = config.optionsDs;

    // Only the field that opened its picker most recently accepts pick
    // events, so a page closed without choosing cannot let a later pick
    // leak into an earlier field.
    const fieldIdRef = useRef(`field-${Math.random().toString(36).slice(2)}`);

    // Captions of the currently selected objects, resolved against the live
    // options so the display updates as soon as the picked object is known.
    const options = useMemo(
        () => getReferenceOptions(config.optionsDs?.items, config.captionAttribute),
        [config.optionsDs?.items, config.captionAttribute]
    );
    const byId = useMemo(() => new Map(options.map(option => [option.id, option.caption])), [options]);
    const selectedCaption = refStore ? refStore.ids.map(id => byId.get(id) ?? "?").join(", ") : "";

    // The opened page reports the pick through the DOM event described in
    // the component doc comment. Events are honored only while this field is
    // pending AND owns the active picker; the GUID is applied to the filter
    // and, when the object is missing from the current options snapshot, the
    // options data source is reloaded once so the caption and the filter
    // literal can resolve against it.
    const handlerRef = useRef<(event: Event) => void>(() => {});
    handlerRef.current = (event: Event): void => {
        if (!pendingRef.current || activeOpener !== fieldIdRef.current || !refStore) {
            return;
        }
        const detail = (event as CustomEvent).detail as { guid?: unknown } | undefined;
        const guid = detail && typeof detail.guid === "string" ? detail.guid : "";
        if (!guid) {
            return;
        }
        pendingRef.current = false;
        activeOpener = null;
        setPending(false);
        refStore.setIds([guid]);
        onChange();
        const ds = optionsDsRef.current;
        if (ds && !(ds.items ?? []).some(item => String(item.id) === guid)) {
            ds.reload();
        }
    };

    useEffect(() => {
        const handler = (event: Event): void => handlerRef.current(event);
        window.addEventListener(PICK_EVENT, handler);
        return () => window.removeEventListener(PICK_EVENT, handler);
    }, []);

    // Safety net: a pick that never reports (the page was closed without
    // choosing) ends the pending state after 30 seconds.
    useEffect(() => {
        if (!pending) {
            return undefined;
        }
        const timer = window.setTimeout(() => {
            pendingRef.current = false;
            if (activeOpener === fieldIdRef.current) {
                activeOpener = null;
            }
            setPending(false);
        }, 30000);
        return () => window.clearTimeout(timer);
    }, [pending]);

    const openPicker = (): void => {
        // Opening the picker starts a new choice: drop the previous selection
        // right away instead of keeping it visible while the page is open,
        // and make this field the sole receiver of the next pick event.
        activeOpener = fieldIdRef.current;
        refStore?.setIds([]);
        onChange();
        pendingRef.current = true;
        setPending(true);
        selectPageAction?.execute();
    };

    const clearSelection = (): void => {
        pendingRef.current = false;
        if (activeOpener === fieldIdRef.current) {
            activeOpener = null;
        }
        setPending(false);
        refStore?.setIds([]);
        onChange();
    };

    if (!refStore) {
        // Select page filters an association; attribute fields cannot host it.
        return (
            <div className="widget-dg2-searchbar__cell">
                <span className="widget-dg2-searchbar__label control-label">{caption}</span>
                <input
                    type="text"
                    className="form-control"
                    disabled
                    placeholder="Select page needs an association field"
                />
            </div>
        );
    }

    return (
        <div className="widget-dg2-searchbar__cell">
            <span className="widget-dg2-searchbar__label control-label">{caption}</span>
            <div className="widget-dg2-searchbar__combo">
                <input
                    type="text"
                    className="form-control"
                    readOnly
                    value={selectedCaption}
                    placeholder={placeholder || "Select…"}
                    title={selectedCaption || undefined}
                />
                {selectedCaption ? (
                    <button
                        type="button"
                        className="widget-dg2-searchbar__combo-clear"
                        aria-label="Clear selection"
                        tabIndex={-1}
                        onClick={clearSelection}
                    >
                        ×
                    </button>
                ) : null}
                {/* Diagonal-arrow button opening the select page. */}
                <button
                    type="button"
                    className="widget-dg2-searchbar__combo-toggle"
                    aria-label={`Open ${caption} selection page`}
                    title="Select…"
                    tabIndex={-1}
                    disabled={!selectPageAction}
                    onMouseDown={event => event.preventDefault()}
                    onClick={openPicker}
                >
                    <span className="widget-dg2-searchbar__select-icon" aria-hidden="true" />
                </button>
            </div>
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
