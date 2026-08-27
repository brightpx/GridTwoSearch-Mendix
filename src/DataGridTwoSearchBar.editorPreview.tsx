import { ReactElement } from "react";

import { DataGridTwoSearchBarPreviewProps } from "../typings/DataGridTwoSearchBarProps";

function parentInline(node?: HTMLElement | null): void {
    // Temporary fix, the web modeler add a containing div, to render inline we need to change it.
    if (node && node.parentElement && node.parentElement.parentElement) {
        node.parentElement.parentElement.style.display = "inline-block";
    }
}

function FieldPreview({
    field,
    translate
}: {
    field: DataGridTwoSearchBarPreviewProps["searchFields"][number];
    translate: (text: string) => string;
}): ReactElement {
    const caption = field.caption || translate("Search");
    const control =
        field.controlType === "selectpage" ? (
            <button type="button" className="btn btn-default" disabled>
                Select…
            </button>
        ) : field.controlType === "datepicker" ? (
            <input type="date" className="form-control" disabled />
        ) : (
            <input
                type={field.controlType === "combobox" ? "text" : "text"}
                className="form-control"
                placeholder={field.placeholder || ""}
                disabled
            />
        );

    return (
        <div className="widget-dg2-searchbar__cell">
            <label className="widget-dg2-searchbar__label control-label">{caption}</label>
            {control}
        </div>
    );
}

export function preview(props: DataGridTwoSearchBarPreviewProps): ReactElement {
    const fields = props.searchFields ?? [];
    return (
        <div ref={parentInline} className="widget-dg2-searchbar mx-layoutgrid mx-layoutgrid-fluid">
            <div className="widget-dg2-searchbar__row form-horizontal">
                {fields.map((field, index) => (
                    <FieldPreview key={index} field={field} translate={props.translate} />
                ))}
                <div className="widget-dg2-searchbar__cell widget-dg2-searchbar__cell--actions">
                    <button type="button" className="btn btn-primary" disabled>
                        {props.clearButtonCaption || "Reset"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function getPreviewCss(): string {
    return require("./ui/DataGridTwoSearchBar.css");
}
