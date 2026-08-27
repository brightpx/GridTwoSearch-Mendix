/**
 * This file was generated from DataGridTwoSearchBar.xml
 * WARNING: All changes made to this file will be overwritten
 * @author Mendix Widgets Framework Team
 */
import {
    ActionValue,
    AssociationMetaData,
    AttributeMetaData,
    DynamicValue,
    ListAttributeValue,
    ListValue
} from "mendix";
import { Big } from "big.js";
import { CSSProperties } from "react";

export type FieldSourceEnum = "attribute" | "association";

export type ControlTypeEnum = "textbox" | "combobox" | "selectpage" | "datepicker";

export interface SearchFieldsType {
    caption: DynamicValue<string>;
    placeholder?: DynamicValue<string>;
    allOptionsCaption?: DynamicValue<string>;
    fieldSource: FieldSourceEnum;
    controlType: ControlTypeEnum;
    attribute: AttributeMetaData<string | Big | boolean | Date>;
    association: AssociationMetaData;
    optionsDs?: ListValue;
    captionAttribute?: ListAttributeValue<string>;
    optionsLimit: number;
    optionsParentAssoc?: AssociationMetaData;
}

export interface SearchFieldsPreviewType {
    caption: string;
    placeholder: string;
    allOptionsCaption: string;
    fieldSource: FieldSourceEnum;
    controlType: ControlTypeEnum;
    attribute: string;
    association: string;
    optionsDs: {} | { caption: string } | { type: string } | null;
    captionAttribute: string;
    optionsLimit: number | null;
    optionsParentAssoc: string;
}

export interface DataGridTwoSearchBarContainerProps {
    name: string;
    class: string;
    style?: CSSProperties;
    tabIndex?: number;
    searchFields: SearchFieldsType[];
    fieldsPerRow: number;
    selectPageAction?: ActionValue;
    searchButtonCaption: DynamicValue<string>;
    clearButtonCaption: DynamicValue<string>;
    filterButtonCaption: DynamicValue<string>;
    allOptionsCaptionDefault?: DynamicValue<string>;
}

export interface DataGridTwoSearchBarPreviewProps {
    /**
     * @deprecated Deprecated since version 9.18.0. Please use class property instead.
     */
    className: string;
    class: string;
    style: string;
    styleObject?: CSSProperties;
    readOnly: boolean;
    renderMode: "design" | "xray" | "structure";
    translate: (text: string) => string;
    searchFields: SearchFieldsPreviewType[];
    fieldsPerRow: number | null;
    selectPageAction: {} | null;
    searchButtonCaption: string;
    clearButtonCaption: string;
    filterButtonCaption: string;
    allOptionsCaptionDefault: string;
}
