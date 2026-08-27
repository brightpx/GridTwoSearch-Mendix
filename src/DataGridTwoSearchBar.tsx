import { ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import classNames from "classnames";
import { association, equals, literal } from "mendix/filters/builders";
import type { ObjectItem } from "mendix";

import { DataGridTwoSearchBarContainerProps, SearchFieldsType } from "../typings/DataGridTwoSearchBarProps";
import { Alert } from "./components/Alert";
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

/**
 * Finds the real option object selected by the field whose association
 * targets the same entity as the given parent association path.
 */
function findParentSelection(fields: FieldEntry[], parentAssoc: { id: string }): ObjectItem | undefined {
    for (const { config, store } of fields) {
        if (
            config.fieldSource === "association" &&
            config.association &&
            targetsSameEntity(config.association.id, parentAssoc.id) &&
            store instanceof ReferenceFilterStore &&
            store.ids.length > 0
        ) {
            const selectedId = store.ids[0];
            return store.options.find(item => String(item.id) === selectedId);
        }
    }
    return undefined;
}

/**
 * Matches a field's association with the parent association path: the parent
 * path (starting at the options entity) must end at the same entity the
 * field's association points to, e.g. field association
 * `.../Address_District/District` vs parent path `District_Province/Province`
 * → compare the LAST segment of the field association with the SECOND-TO-LAST
 * segment of the parent path (the parent entity of the options entity).
 */
function targetsSameEntity(fieldAssocId: string, parentAssocId: string): boolean {
    const fieldParts = fieldAssocId.split("/");
    const parentParts = parentAssocId.split("/");
    if (fieldParts.length < 1 || parentParts.length < 2) {
        return false;
    }
    const fieldTarget = fieldParts[fieldParts.length - 1];
    // The parent entity of the options entity = second-to-last path segment.
    const parentTarget = parentParts[parentParts.length - 2];
    return fieldTarget === parentTarget;
}

/** Resolves the caption text of a textTemplate prop. */
function templateText(value: { value?: string } | undefined, fallback: string): string {
    const text = value?.value;
    return text && text.trim().length > 0 ? text : fallback;
}

export function DataGridTwoSearchBar(props: DataGridTwoSearchBarContainerProps): ReactElement {
    const { api, error } = useFilterAPI();
    const observer = api?.filterObserver ?? null;

    // One store per configured field, recreated only when the configuration
    // (not the runtime values) changes.
    const fields = useMemo<FieldEntry[]>(
        () =>
            props.searchFields.map((config, index) => ({
                key: `${props.name}#${index}`,
                config,
                store: createStore(config)
            })),
        [props.searchFields, props.name]
    );

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

    // Cascading options: when a parent field (e.g. province) has a selection,
    // constrain the options data source of child fields (e.g. district) that
    // declare a parent association path to the same target entity.
    useEffect(() => {
        for (const { config, store } of fields) {
            const parentAssoc = config.optionsParentAssoc;
            if (!parentAssoc || !(store instanceof ReferenceFilterStore) || !config.optionsDs) {
                continue;
            }
            const parentSelection = findParentSelection(fields, parentAssoc);
            const cond = parentSelection
                ? equals(association(parentAssoc.id as AssocId), literal(parentSelection))
                : undefined;
            config.optionsDs.setFilter(cond);
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
