import { ReactElement, UIEvent, WheelEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import classNames from "classnames";
import { autoUpdate, flip, size, useFloating } from "@floating-ui/react-dom";
import { useCombobox } from "downshift";
import { and, association, attribute, contains, equals, literal } from "mendix/filters/builders";
import type { ObjectItem } from "mendix";

import { DataGridTwoSearchBarContainerProps, SearchFieldsType } from "../typings/DataGridTwoSearchBarProps";
import { Alert } from "./components/Alert";
import { entityOfGuid, getDomainGraph } from "./filtering/entity-meta";
import { useFilterAPI } from "./filtering/global-context";
import {
    BaseFilterStore,
    cancelDeferredUnsync,
    createAttributeStore,
    DateFilterStore,
    deferredUnsync,
    getReferenceOptions,
    getUniverseOptions,
    ReferenceFilterStore,
    SelectFilterStore,
    syncFilter,
    TextFilterStore
} from "./filtering/stores";
import "./ui/DataGridTwoSearchBar.css";

type FieldConfig = SearchFieldsType;

/** Branded association id type expected by the filter builders. */
type AssocId = Parameters<typeof association>[0];
/** Branded attribute id type expected by the filter builders. */
type AttrId = Parameters<typeof attribute>[0];
/** Filter condition accepted by an options data source, including no filter. */
type OptionFilter = NonNullable<FieldConfig["optionsDs"]>["filter"];

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
            return { key, config, store: createStore(config, key) };
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
    //
    // The unmount cleanup is deferred by one tick (deferredUnsync): this
    // effect runs on EVERY render (no dependency array), so an immediate
    // unobserve would fire on every re-render too — momentarily removing
    // each condition from the host, pushing `undefined` into the grid and
    // starting an unfiltered reload that can win the race against the
    // re-observed condition (see syncFilter). The next effect run cancels
    // the pending cleanup, so only a genuine unmount ever unobserves.
    useEffect(() => {
        if (!observer || props.searchOnButtonClick) {
            return undefined;
        }
        cancelDeferredUnsync(observer);
        for (const { key, store } of fields) {
            syncFilter(observer, key, store);
        }
        return () => {
            deferredUnsync(
                observer,
                fields.map(({ key }) => key)
            );
        };
    });

    // Reference filters need the REAL option objects to build valid filter
    // literals; keep the store's options in sync with the data source items.
    // A changed items identity (e.g. the reload issued after a select-page
    // pick) also bumps the version so syncFilter re-reads the conditions
    // with the fresh options in the following render.
    const lastOptionsItems = useRef<Map<string, unknown>>(new Map());
    // Match-value retry bookkeeping: pending re-render timer, attempt count
    // and the picked-ids signature the attempts belong to (see the retry
    // block at the end of this effect).
    const matchRetryTimer = useRef<number | undefined>(undefined);
    const matchRetryAttempts = useRef(0);
    const matchRetryIds = useRef("");
    useEffect(() => {
        let changed = false;
        for (const { key, config, store } of fields) {
            if (store instanceof ReferenceFilterStore) {
                // Attribute-match mode: when enabled AND both match
                // attributes are configured, the filter compares the
                // grid-side attribute with the option-side attribute value
                // of the picked object instead of filtering the association
                // itself. The toggle lets the user switch back to plain
                // association filtering without clearing the attributes.
                store.setMatchConfig(
                    config.matchEnabled !== false && config.matchAttribute && config.matchOptionAttribute
                        ? {
                              attributeId: config.matchAttribute.id,
                              attributeType: config.matchAttribute.type,
                              filterable: config.matchAttribute.filterable,
                              optionAttribute: config.matchOptionAttribute
                          }
                        : undefined
                );
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
        // A picked option whose match value is still loading builds no
        // condition, which would silently drop the filter until the next
        // re-sync — and without a re-render there never is one. Re-render
        // on a short timer until every picked id resolves (the registration
        // effect re-reads the conditions each pass), so the filter
        // converges as soon as the options data source delivers the values.
        // Attempts reset on every selection change and are capped so a
        // value that never arrives cannot poll forever.
        const idsSignature = fields
            .map(({ store }) => (store instanceof ReferenceFilterStore ? store.ids.join(",") : ""))
            .join("|");
        if (idsSignature !== matchRetryIds.current) {
            matchRetryIds.current = idsSignature;
            matchRetryAttempts.current = 0;
        }
        const needsMatchRetry = fields.some(
            ({ store }) =>
                store instanceof ReferenceFilterStore && store.ids.length > 0 && store.unresolvedIds().length > 0
        );
        if (needsMatchRetry && matchRetryAttempts.current < 25) {
            matchRetryAttempts.current += 1;
            if (matchRetryTimer.current === undefined) {
                matchRetryTimer.current = window.setTimeout(() => {
                    matchRetryTimer.current = undefined;
                    bump();
                }, 200);
            }
        } else if (!needsMatchRetry) {
            matchRetryAttempts.current = 0;
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
    // Desired data source state per cascade child (filter signature, limit,
    // offset). The lazy-load effect runs in the same pass and can re-page the
    // data source AFTER the cascade applied its state; comparing the live
    // data source against the desired state makes the cascade re-assert
    // itself on the next pass instead of skipping on an unchanged signature.
    const desiredDsState = useRef<Map<string, { filterSig: string; limit: number | undefined; offset: number }>>(
        new Map()
    );
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
                // External-entity fields (attribute match without an
                // association) have no parent association to cascade on.
                if (
                    config.association &&
                    config.optionsParentAssoc &&
                    config.optionsDs &&
                    store instanceof ReferenceFilterStore
                ) {
                    cascadeFields.push({ key: config.association.id, config, store, ds: config.optionsDs });
                }
            }
            if (cascadeFields.length === 0) {
                return undefined;
            }

            // Collect selections of all association fields — these are the
            // candidate cascade drivers. External-entity fields (no
            // association) cannot drive a cascade: their options entity is
            // unrelated to the other fields' option entities.
            const selections = new Map<string, ObjectItem>();
            for (const { config, store } of fields) {
                if (
                    config.fieldSource === "association" &&
                    config.association &&
                    store instanceof ReferenceFilterStore &&
                    store.ids[0]
                ) {
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
                const lazyPage =
                    field.config.optionsLazyLoad === true ? Math.max(1, field.config.optionsPageSize || 50) : undefined;
                // The state this field's data source should be in right now.
                const desired = best
                    ? // Driver selected: filtered, offset reset, paged when lazy.
                      { filterSig: signature, limit: lazyPage, offset: 0 }
                    : field.config.cascadeEmptyBehavior === "showall"
                    ? // No parent but show-all: unfiltered, still paged when lazy.
                      { filterSig: "", limit: lazyPage, offset: 0 }
                    : // No parent and strict cascade: empty.
                      { filterSig: "", limit: 0, offset: 0 };
                const applied = desiredDsState.current.get(field.key);
                // Once lazy loading has grown the limit, that larger value is
                // still the desired state. Resetting it to `lazyPage` here
                // would collapse the list back to page one after every load.
                const limitMatchesDesired =
                    lazyPage !== undefined && desired.limit === lazyPage
                        ? field.ds.limit !== undefined && field.ds.limit >= lazyPage
                        : field.ds.limit === desired.limit;
                const dsMatchesDesired =
                    (field.ds.filter !== undefined) === (desired.filterSig !== "") &&
                    limitMatchesDesired &&
                    (desired.filterSig === "" || field.ds.offset === desired.offset);
                if (applied && applied.filterSig === desired.filterSig && dsMatchesDesired) {
                    continue;
                }
                desiredDsState.current.set(field.key, desired);
                appliedCascades.current.set(field.key, signature);
                if (best) {
                    const driver = [...selections.values()].find(obj => String(obj.id) === best.guid);
                    if (driver) {
                        // Lazy-loaded fields keep their page size so scrolling
                        // still pages through the filtered result; unlimited
                        // fields load the whole filtered list at once. The
                        // offset resets so a previously scrolled position
                        // cannot skip the first page of the new result.
                        field.ds.setOffset(0);
                        field.ds.setLimit(lazyPage);
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
                field.ds.setOffset(0);
                field.ds.setLimit(desired.limit);
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
            if (matchRetryTimer.current !== undefined) {
                window.clearTimeout(matchRetryTimer.current);
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
                        <div key={rowIndex} className="widget-dg2-searchbar__row">
                            {rowFields.map(({ key, config, store }) => (
                                <SearchFieldControl
                                    key={key}
                                    config={config}
                                    store={store}
                                    selectPageAction={props.selectPageAction}
                                    allOptionsCaptionDefault={templateText(props.allOptionsCaptionDefault, "")}
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
                                className="mx-button btn btn-default"
                                aria-expanded={fieldsVisible}
                                onClick={toggleFields}
                            >
                                {templateText(props.filterButtonCaption, "Filter")}
                            </button>
                        ) : null}
                        {props.customButtons?.map((button, index) => {
                            const caption = templateText(button.caption, `Button ${index + 1}`);
                            const styleClass = `mx-button btn btn-${button.buttonStyle}`;
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
                            <button type="button" className="mx-button btn btn-primary" onClick={applySearch}>
                                {templateText(props.searchButtonCaption, "Search")}
                            </button>
                        ) : null}
                        {props.showClearButton !== false ? (
                            <button
                                type="button"
                                className="mx-button btn btn-default"
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
                    allOptionsCaption={templateText(config.allOptionsCaption, allOptionsCaptionDefault)}
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

interface ComboBoxChoice {
    value: string;
    caption: string;
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
                ? getReferenceOptions(config.optionsDs?.items, config.captionAttribute, config.captionTemplate)
                : getUniverseOptions(config.attribute),
        [isReference, config.optionsDs?.items, config.captionAttribute, config.captionTemplate, config.attribute]
    );

    const generatedId = useId().replace(/:/g, "");
    const inputId = `sb-combobox-${generatedId}`;
    const labelId = `${inputId}-label`;
    const menuId = `${inputId}-menu`;
    const toggleButtonId = `${inputId}-toggle`;
    const inputRef = useRef<HTMLInputElement | null>(null);

    let selected = "";
    if (store instanceof SelectFilterStore) {
        selected = store.values.join(",");
    } else if (store instanceof ReferenceFilterStore) {
        selected = store.ids.join(",");
    }
    const selectedValue = selected.split(",")[0] || "";

    // Caption of the currently selected option — shown in the closed input.
    const selectedCaption = useMemo(() => {
        if (!selected) {
            return "";
        }
        const ids = selected.split(",");
        return allOptions.find(option => ids.includes("id" in option ? option.id : option.value))?.caption ?? "";
    }, [selected, allOptions]);
    const [selectedCaptionFallback, setSelectedCaptionFallback] = useState({ value: "", caption: "" });
    const selectedDisplayCaption = selected
        ? selectedCaption || (selectedCaptionFallback.value === selectedValue ? selectedCaptionFallback.caption : "")
        : "";

    // Match the native filterable combobox: the selected caption is the
    // closed value, focus selects it, and user input becomes the visible
    // local filter. Placeholder text never covers typed input.
    const [query, setQuery] = useState("");
    const [queryTouched, setQueryTouched] = useState(false);

    // Lazy loading (reference fields only): the options data source is
    // paged by growing its limit, matching the native Mendix dropdown filter.
    // The next page is requested when the dropdown is scrolled to the bottom,
    // so previously loaded options remain in `items`.
    const ds = config.optionsDs;
    const lazy = isReference && config.optionsLazyLoad === true && !!ds;
    const pageSize = Math.max(1, config.optionsPageSize || 50);
    const canServerSearch =
        lazy && !!ds && ds.limit !== 0 && config.captionAttribute?.filterable === true && !!config.captionAttribute.id;

    // Case-insensitive substring match over captions; then cap the list at
    // `optionsLimit` entries so huge option sets stay usable. Lazy-loaded
    // fields ignore the display limit: the data source is already paged by
    // the page size, so capping again would only hide options that were
    // fetched for the scroll-to-load flow.
    const limit = lazy ? Number.POSITIVE_INFINITY : Math.max(1, config.optionsLimit || 100);
    const filtered = useMemo(() => {
        const q = queryTouched ? query.trim().toLowerCase() : "";
        const matched = q ? allOptions.filter(option => option.caption.toLowerCase().includes(q)) : allOptions;
        return matched.slice(0, limit);
    }, [allOptions, query, queryTouched, limit]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [serverSearchPending, setServerSearchPending] = useState(false);
    const lastRequestedLimit = useRef<number | null>(null);
    const serverSearchActive = useRef(false);
    const serverSearchBaseFilter = useRef<OptionFilter>(undefined);
    const serverSearchRequestItems = useRef(ds?.items);
    const dataSourceLoading = ds?.status === "loading";

    // Keep the page size in sync with the property; a changed size invalidates
    // the paging bookkeeping so the next scroll request starts from the
    // configured page size. The cascade effect owns the data source while a
    // parent filter is applied (filter set) or while it forces the empty
    // state (limit 0) — paging must not fight it, so those states are left
    // untouched. A changed filter identity (cascade applied/cleared) resets
    // the paging bookkeeping so scrolling restarts from the new result.
    const lastFilterRef = useRef(ds?.filter);
    useEffect(() => {
        if (!lazy || !ds) {
            return;
        }
        if (lastFilterRef.current !== ds.filter) {
            lastFilterRef.current = ds.filter;
            lastRequestedLimit.current = null;
        }
        if (ds.filter === undefined && ds.limit !== 0 && lastRequestedLimit.current === null && ds.limit !== pageSize) {
            ds.setLimit(pageSize);
        }
    });

    const loadMore = useCallback(() => {
        if (!lazy || !ds || loadingMore || serverSearchPending || dataSourceLoading || ds.limit === 0) {
            return;
        }
        if (ds.hasMoreItems === false) {
            return;
        }
        const nextLimit = ds.limit + pageSize;
        if (nextLimit === lastRequestedLimit.current) {
            return;
        }
        lastRequestedLimit.current = nextLimit;
        setLoadingMore(true);
        ds.setLimit(nextLimit);
    }, [lazy, ds, loadingMore, serverSearchPending, dataSourceLoading, pageSize]);

    // Clear the loading flag when the requested page arrives (items identity
    // changes) or when the data source reports no more items.
    const currentItems = ds?.items;
    const hasMoreItems = ds?.hasMoreItems;
    const lastItemsRef = useRef(currentItems);
    useEffect(() => {
        if (!loadingMore) {
            lastItemsRef.current = currentItems;
        } else if (ds && (lastItemsRef.current !== currentItems || hasMoreItems === false)) {
            lastItemsRef.current = currentItems;
            setLoadingMore(false);
        }
    }, [currentItems, ds, hasMoreItems, loadingMore]);

    // A server-side search is complete when the filtered request returns a
    // new item collection. Keeping this separate from scroll loading prevents
    // a transient empty local result from being reported as "No matches".
    useEffect(() => {
        if (serverSearchPending && ds?.status === "available" && serverSearchRequestItems.current !== currentItems) {
            serverSearchRequestItems.current = currentItems;
            setServerSearchPending(false);
        }
    }, [currentItems, ds?.status, serverSearchPending]);

    const onListScroll = (event: UIEvent<HTMLUListElement>): void => {
        if (!lazy) {
            return;
        }
        const el = event.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
            loadMore();
        }
    };

    // A page can be shorter than the menu viewport, leaving no scrollbar and
    // therefore no scroll event. Treat a downward wheel gesture over that
    // short menu as the request for the next page, while still keeping the
    // configured page size as the exact initial/incremental batch size.
    const onListWheel = (event: WheelEvent<HTMLUListElement>): void => {
        if (!lazy || event.deltaY <= 0) {
            return;
        }
        const el = event.currentTarget;
        if (el.scrollHeight <= el.clientHeight + 1) {
            loadMore();
        }
    };

    const restoreServerSearch = useCallback((): void => {
        if (!ds || !serverSearchActive.current) {
            return;
        }
        const baseFilter = serverSearchBaseFilter.current;
        serverSearchActive.current = false;
        serverSearchRequestItems.current = ds.items;
        lastRequestedLimit.current = null;
        setServerSearchPending(false);
        setLoadingMore(false);
        if (ds.offset !== 0) {
            ds.setOffset(0);
        }
        if (ds.limit !== pageSize) {
            ds.setLimit(pageSize);
        }
        if (ds.filter !== baseFilter) {
            ds.setFilter(baseFilter);
        }
    }, [ds, pageSize]);

    const applyServerSearch = useCallback(
        (rawQuery: string): void => {
            const term = rawQuery.trim();
            if (!term) {
                restoreServerSearch();
                return;
            }
            if (!canServerSearch || !ds || !config.captionAttribute) {
                return;
            }
            if (!serverSearchActive.current) {
                serverSearchBaseFilter.current = ds.filter;
                serverSearchActive.current = true;
            }
            const captionFilter = contains(attribute(config.captionAttribute.id as AttrId), literal(term));
            const baseFilter = serverSearchBaseFilter.current;
            const combinedFilter = baseFilter ? and(baseFilter, captionFilter) : captionFilter;
            serverSearchRequestItems.current = ds.items;
            lastRequestedLimit.current = null;
            setLoadingMore(false);
            setServerSearchPending(true);
            if (ds.offset !== 0) {
                ds.setOffset(0);
            }
            if (ds.limit !== pageSize) {
                ds.setLimit(pageSize);
            }
            ds.setFilter(combinedFilter);
        },
        [canServerSearch, config.captionAttribute, ds, pageSize, restoreServerSearch]
    );

    const commit = (value: string, optionCaption = ""): void => {
        restoreServerSearch();
        setQuery("");
        setQueryTouched(false);
        setSelectedCaptionFallback(value ? { value, caption: optionCaption } : { value: "", caption: "" });
        if (store instanceof SelectFilterStore) {
            store.setValues(value ? value.split(",") : []);
        } else if (store instanceof ReferenceFilterStore) {
            store.setIds(value ? [value] : []);
        }
        if (lazy && ds) {
            lastRequestedLimit.current = null;
            setLoadingMore(false);
            if (ds.offset !== 0) {
                ds.setOffset(0);
            }
            if (ds.limit !== pageSize) {
                ds.setLimit(pageSize);
            }
        }
        onChange();
    };

    const allChoice = useMemo<ComboBoxChoice>(() => ({ value: "", caption: allOptionsCaption }), [allOptionsCaption]);
    const visibleChoices = useMemo<ComboBoxChoice[]>(
        () => [
            ...(queryTouched && query.trim() ? [] : [allChoice]),
            ...filtered.map(option => ({
                value: "id" in option ? option.id : option.value,
                caption: option.caption
            }))
        ],
        [allChoice, filtered, query, queryTouched]
    );
    const selectedChoice = useMemo<ComboBoxChoice>(() => {
        if (!selectedValue) {
            return allChoice;
        }
        const option = allOptions.find(item => ("id" in item ? item.id : item.value) === selectedValue);
        return option
            ? { value: selectedValue, caption: option.caption }
            : { value: selectedValue, caption: selectedDisplayCaption };
    }, [allChoice, allOptions, selectedDisplayCaption, selectedValue]);
    const inputValue = queryTouched ? query : selectedDisplayCaption;
    const hasSearchQuery = queryTouched && query.trim().length > 0;
    // A local match cannot be considered final while lazy pages remain.
    // Keep requesting exactly one configured page at a time until at least
    // one match is available or the data source confirms that it is exhausted.
    const searchNeedsMore =
        lazy &&
        !canServerSearch &&
        !!ds &&
        ds.limit !== 0 &&
        hasSearchQuery &&
        filtered.length === 0 &&
        ds.hasMoreItems !== false;

    const { isOpen, highlightedIndex, getLabelProps, getInputProps, getToggleButtonProps, getMenuProps, getItemProps } =
        useCombobox<ComboBoxChoice>({
            items: visibleChoices,
            itemToString: item => item?.caption ?? "",
            itemToKey: item => item?.value ?? "",
            selectedItem: selectedChoice,
            inputValue,
            id: generatedId,
            labelId,
            menuId,
            inputId,
            toggleButtonId,
            getItemId: index => `${inputId}-item-${index}`,
            onInputValueChange: changes => {
                if (changes.type === useCombobox.stateChangeTypes.InputChange) {
                    const nextQuery = changes.inputValue ?? "";
                    setQueryTouched(true);
                    setQuery(nextQuery);
                    applyServerSearch(nextQuery);
                }
            },
            onSelectedItemChange: changes => {
                if (
                    changes.selectedItem &&
                    changes.type !== useCombobox.stateChangeTypes.InputBlur &&
                    changes.type !== useCombobox.stateChangeTypes.InputKeyDownEscape
                ) {
                    commit(changes.selectedItem.value, changes.selectedItem.caption);
                }
            },
            onIsOpenChange: changes => {
                if (!changes.isOpen) {
                    restoreServerSearch();
                    setQuery("");
                    setQueryTouched(false);
                }
            },
            stateReducer: (state, { changes }) => {
                return {
                    ...changes,
                    highlightedIndex: changes.inputValue !== state.inputValue ? 0 : changes.highlightedIndex
                };
            }
        });

    useEffect(() => {
        if (isOpen && searchNeedsMore && !loadingMore && !dataSourceLoading) {
            loadMore();
        }
    }, [dataSourceLoading, isOpen, loadMore, loadingMore, searchNeedsMore]);

    const floatingMiddleware = useMemo(
        () => [
            size({
                apply({ rects, elements }): void {
                    Object.assign(elements.floating.style, { width: `${rects.reference.width}px` });
                }
            }),
            flip({ crossAxis: false, fallbackStrategy: "initialPlacement" })
        ],
        []
    );
    const { refs, floatingStyles } = useFloating({
        open: isOpen,
        placement: "bottom-start",
        strategy: "fixed",
        middleware: floatingMiddleware,
        whileElementsMounted: autoUpdate
    });
    // Downshift's prop getter intentionally attaches its menu ref during
    // render; this is the library's supported integration pattern.
    // eslint-disable-next-line react-hooks/refs
    const menuProps = getMenuProps({
        className: "widget-dropdown-filter-menu",
        onScroll: onListScroll,
        onWheel: onListWheel
    });

    return (
        <div className="widget-dg2-searchbar__cell">
            <label {...getLabelProps({ className: "widget-dg2-searchbar__label control-label" })}>{caption}</label>
            <div
                ref={refs.setReference}
                className="widget-dg2-searchbar__combo widget-dg2-searchbar__combo--dropdown widget-dropdown-filter form-control variant-combobox"
                data-expanded={isOpen}
                data-empty={!selected ? true : undefined}
            >
                <input
                    className="widget-dg2-searchbar__combo-input widget-dropdown-filter-input"
                    {...getInputProps({
                        ref: inputRef,
                        "aria-label": caption,
                        placeholder: !selected
                            ? isOpen
                                ? placeholder || "Type to filter…"
                                : allOptionsCaption
                            : undefined,
                        onFocus: event => event.currentTarget.select(),
                        onBlur: () => {
                            restoreServerSearch();
                            setQuery("");
                            setQueryTouched(false);
                        }
                    })}
                />
                {selected ? (
                    <button
                        type="button"
                        className="widget-dropdown-filter-clear"
                        aria-label="Clear selection"
                        onClick={event => {
                            event.stopPropagation();
                            event.preventDefault();
                            commit("");
                            inputRef.current?.focus();
                        }}
                        onKeyDown={event => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                            }
                        }}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 32 32"
                            className="widget-dropdown-filter-clear-icon"
                            aria-hidden="true"
                        >
                            <path
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="currentColor"
                                d="M27.71 5.71004L26.29 4.29004L16 14.59L5.71004 4.29004L4.29004 5.71004L14.59 16L4.29004 26.29L5.71004 27.71L16 17.41L26.29 27.71L27.71 26.29L17.41 16L27.71 5.71004Z"
                            />
                        </svg>
                    </button>
                ) : null}
                <button
                    className="widget-dropdown-filter-toggle"
                    {...getToggleButtonProps({ type: "button", "aria-label": `Show ${caption} options` })}
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 32 32"
                        className="widget-dropdown-filter-state-icon"
                        aria-hidden="true"
                    >
                        <path d="M16 23.41L4.29004 11.71L5.71004 10.29L16 20.59L26.29 10.29L27.71 11.71L16 23.41Z" />
                    </svg>
                </button>
                <div
                    className="widget-dg2-searchbar__combo-popover widget-dropdown-filter-popover"
                    ref={refs.setFloating}
                    style={floatingStyles}
                    hidden={!isOpen}
                    data-overlay-content={isOpen ? true : undefined}
                >
                    <div className="widget-dropdown-filter-menu-slot">
                        <ul {...menuProps}>
                            {isOpen ? (
                                <>
                                    {visibleChoices.map((option, index) => {
                                        const active = option.value === selectedValue;
                                        return (
                                            <li
                                                key={`${option.value}-${option.caption}`}
                                                {...getItemProps({
                                                    item: option,
                                                    index,
                                                    className: "widget-dropdown-filter-menu-item",
                                                    title: option.caption,
                                                    onClick: event => event.stopPropagation()
                                                })}
                                                data-selected={active ? true : undefined}
                                                data-highlighted={highlightedIndex === index ? true : undefined}
                                            >
                                                <span className="widget-dropdown-filter-menu-item-text">
                                                    {option.caption}
                                                </span>
                                            </li>
                                        );
                                    })}
                                    {filtered.length === 0 && !searchNeedsMore && !serverSearchPending ? (
                                        <li className="widget-dg2-searchbar__combo-item--empty widget-dropdown-filter-menu-item">
                                            <span className="widget-dropdown-filter-menu-item-text">No matches</span>
                                        </li>
                                    ) : null}
                                    {lazy && (loadingMore || searchNeedsMore || serverSearchPending) ? (
                                        <li className="widget-dg2-searchbar__combo-item--empty widget-dropdown-filter-menu-item">
                                            <span className="widget-dropdown-filter-menu-item-text">Loading…</span>
                                        </li>
                                    ) : null}
                                    {lazy &&
                                    !loadingMore &&
                                    !serverSearchPending &&
                                    ds.hasMoreItems === false &&
                                    filtered.length > 0 ? (
                                        <li className="widget-dg2-searchbar__combo-item--empty widget-dropdown-filter-menu-item">
                                            <span className="widget-dropdown-filter-menu-item-text">
                                                All {allOptions.length} options loaded
                                            </span>
                                        </li>
                                    ) : null}
                                </>
                            ) : null}
                        </ul>
                    </div>
                </div>
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
                        className="mx-button widget-dg2-searchbar__combo-clear"
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
        () => getReferenceOptions(config.optionsDs?.items, config.captionAttribute, config.captionTemplate),
        [config.optionsDs?.items, config.captionAttribute, config.captionTemplate]
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
                        className="mx-button widget-dg2-searchbar__combo-clear"
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
                    className="mx-button widget-dg2-searchbar__combo-toggle"
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
function createStore(config: FieldConfig, fieldKey: string): BaseFilterStore {
    if (config.fieldSource === "association") {
        // Association fields have no attribute configured; the reference
        // type (Reference vs ReferenceSet) is probed inside the store.
        //
        // The association itself is optional in attribute-match mode: the
        // options data source may point at an external entity (e.g. Address)
        // that is not linked to the grid entity, so no association exists to
        // filter. The store still needs a stable serialization key — the
        // field key (`<widget>#<index>`) is unique and survives page
        // reloads, so a restored filter re-enters the same store.
        const assoc = config.association;
        return new ReferenceFilterStore({
            // No association: `filterable: false` keeps plain-association
            // filtering inert (the condition getter returns undefined);
            // attribute-match mode checks the match attribute's filterable
            // flag instead, so it stays fully functional.
            id: assoc ? assoc.id : fieldKey,
            filterable: assoc ? assoc.filterable : false
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
