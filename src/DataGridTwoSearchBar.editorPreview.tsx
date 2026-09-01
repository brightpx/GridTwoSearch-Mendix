import { ReactElement } from "react";

import { DataGridTwoSearchBarPreviewProps } from "../typings/DataGridTwoSearchBarProps";

type Field = DataGridTwoSearchBarPreviewProps["searchFields"][number];
type Button = DataGridTwoSearchBarPreviewProps["customButtons"][number];

function parentInline(node?: HTMLElement | null): void {
    // Temporary fix, the web modeler add a containing div, to render inline we need to change it.
    if (node && node.parentElement && node.parentElement.parentElement) {
        node.parentElement.parentElement.style.display = "inline-block";
    }
}

/**
 * Studio Pro design preview mirroring the runtime UI: the same cell/label
 * structure, combo box with the ▼ toggle on the right edge, date picker with
 * the calendar glyph, select page with the diagonal-arrow button, fields
 * chunked into rows by Fields per row, and the actions row with the Filter,
 * custom, Search and Reset buttons exactly where runtime renders them.
 * All controls are disabled — the preview is static.
 */
function FieldPreview({ field }: { field: Field }): ReactElement {
    const caption = field.caption || "Search";
    const placeholder = field.placeholder || "";

    let control: ReactElement;
    if (field.controlType === "selectpage") {
        control = (
            <div className="widget-dg2-searchbar__combo">
                <input type="text" className="form-control" placeholder={placeholder || "Select…"} readOnly disabled />
                <button type="button" className="mx-button widget-dg2-searchbar__combo-toggle" tabIndex={-1} disabled>
                    <span className="widget-dg2-searchbar__select-icon" aria-hidden="true" />
                </button>
            </div>
        );
    } else if (field.controlType === "datepicker") {
        const format = field.dateFormat || "";
        const single = format ? (
            <div className="widget-dg2-searchbar__datewrap">
                <input type="text" className="form-control" placeholder={format} disabled />
                <span className="widget-dg2-searchbar__date-icon" aria-hidden="true" />
            </div>
        ) : (
            <input type="date" className="form-control" disabled />
        );
        control =
            field.dateRange && format ? (
                <div className="widget-dg2-searchbar__combo">
                    <div className="widget-dg2-searchbar__daterange">
                        <div className="widget-dg2-searchbar__datewrap">
                            <input type="text" className="form-control" placeholder={format} disabled />
                            <span className="widget-dg2-searchbar__date-icon" aria-hidden="true" />
                        </div>
                        <div className="widget-dg2-searchbar__datewrap">
                            <input type="text" className="form-control" placeholder={format} disabled />
                            <span className="widget-dg2-searchbar__date-icon" aria-hidden="true" />
                        </div>
                    </div>
                </div>
            ) : field.dateRange ? (
                <div className="widget-dg2-searchbar__combo">
                    <div className="widget-dg2-searchbar__daterange">
                        <input type="date" className="form-control" disabled />
                        <input type="date" className="form-control" disabled />
                    </div>
                </div>
            ) : (
                single
            );
    } else if (field.controlType === "combobox") {
        control = (
            <div
                className="widget-dg2-searchbar__combo widget-dg2-searchbar__combo--dropdown widget-dropdown-filter form-control variant-combobox"
                data-expanded="false"
                data-empty="true"
            >
                <input
                    className="widget-dg2-searchbar__combo-input widget-dropdown-filter-input"
                    placeholder={field.allOptionsCaption || "-- all --"}
                    disabled
                />
                <button type="button" className="widget-dropdown-filter-toggle" tabIndex={-1} disabled>
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
                <div className="widget-dg2-searchbar__combo-popover widget-dropdown-filter-popover" hidden>
                    <div className="widget-dropdown-filter-menu-slot">
                        <ul className="widget-dropdown-filter-menu" role="listbox" />
                    </div>
                </div>
            </div>
        );
    } else {
        control = <input type="text" className="form-control" placeholder={placeholder} disabled />;
    }

    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label">{caption}</label>
            {control}
        </div>
    );
}

function ButtonPreview({ button, index }: { button: Button; index: number }): ReactElement {
    return (
        <button type="button" className={`mx-button btn btn-${button.buttonStyle || "default"}`} tabIndex={-1} disabled>
            {button.caption || `Button ${index + 1}`}
        </button>
    );
}

export function preview(props: DataGridTwoSearchBarPreviewProps): ReactElement {
    // Structure mode (Studio Pro's structure/outline view) renders a compact
    // summary chip instead of the full design preview, matching how Mendix
    // widgets present themselves in the widget tree.
    if (props.renderMode === "structure") {
        const count = (props.searchFields ?? []).length;
        const summary = count > 0 ? `${count} search field${count === 1 ? "" : "s"}` : "no search fields";
        return (
            <div className="widget-dg2-searchbar-structure">
                <span className="widget-dg2-searchbar-structure__name">DataGridTwoSearchBar</span>
                <span className="widget-dg2-searchbar-structure__meta">({summary})</span>
            </div>
        );
    }

    const fields = props.searchFields ?? [];
    const buttons = props.customButtons ?? [];
    const hasFields = fields.length > 0;
    // The preview always draws the fields area: "Show fields by default"
    // only controls the runtime initial collapsed state, and hiding the
    // fields here would make the widget look like a bare button row in
    // Studio Pro.
    const perRow = Math.max(1, props.fieldsPerRow || 5);
    const rows: Field[][] = [];
    for (let i = 0; i < fields.length; i += perRow) {
        rows.push(fields.slice(i, i + perRow));
    }

    return (
        <div ref={parentInline} className="widget-dg2-searchbar mx-layoutgrid mx-layoutgrid-fluid">
            {!hasFields ? (
                <div className="alert alert-info widget-dg2-searchbar__alert">
                    {props.translate("No search fields configured.")}
                </div>
            ) : null}
            {hasFields ? (
                <div className="widget-dg2-searchbar__fields">
                    {rows.map((rowFields, rowIndex) => (
                        <div key={rowIndex} className="widget-dg2-searchbar__row">
                            {rowFields.map((field, index) => (
                                <FieldPreview key={index} field={field} />
                            ))}
                        </div>
                    ))}
                </div>
            ) : null}
            {hasFields ? (
                <div className="widget-dg2-searchbar__actions-row">
                    <div className="widget-dg2-searchbar__actions-left">
                        {props.showFilterButton !== false ? (
                            <button type="button" className="mx-button btn btn-default" tabIndex={-1} disabled>
                                {props.filterButtonCaption || "Filter"}
                            </button>
                        ) : null}
                        {buttons.map((button, index) => (
                            <ButtonPreview key={index} button={button} index={index} />
                        ))}
                    </div>
                    <div className="widget-dg2-searchbar__actions-right">
                        {props.searchOnButtonClick && props.showSearchButton !== false ? (
                            <button type="button" className="mx-button btn btn-primary" tabIndex={-1} disabled>
                                {props.searchButtonCaption || "Search"}
                            </button>
                        ) : null}
                        {props.showClearButton !== false ? (
                            <button type="button" className="mx-button btn btn-default" tabIndex={-1} disabled>
                                {props.clearButtonCaption || "Reset"}
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export function getPreviewCss(): string {
    return require("./ui/DataGridTwoSearchBar.css");
}
