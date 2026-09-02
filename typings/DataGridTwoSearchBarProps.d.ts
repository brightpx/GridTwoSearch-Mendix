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
    ListExpressionValue,
    ListValue
} from "mendix";
import { Big } from "big.js";
import { CSSProperties } from "react";

export type FieldSourceEnum = "attribute" | "association";

export type ControlTypeEnum = "textbox" | "combobox" | "selectpage" | "datepicker";

export type CascadeEmptyBehaviorEnum = "showall" | "shownone";

export interface SearchFieldsType {
    caption: DynamicValue<string>;
    placeholder?: DynamicValue<string>;
    fieldSource: FieldSourceEnum;
    controlType: ControlTypeEnum;
    attribute: AttributeMetaData<string | Big | boolean | Date>;
    association?: AssociationMetaData;
    optionsDs?: ListValue;
    captionAttribute?: ListAttributeValue<string>;
    captionTemplate?: ListExpressionValue<string>;
    matchEnabled: boolean;
    matchAttribute?: AttributeMetaData<string | Big | boolean | Date>;
    matchOptionAttribute?: ListAttributeValue<string | Big | boolean | Date>;
    allOptionsCaption?: DynamicValue<string>;
    optionsLimit: number;
    optionsLazyLoad: boolean;
    optionsPageSize: number;
    optionsParentAssoc?: AssociationMetaData;
    cascadeEmptyBehavior: CascadeEmptyBehaviorEnum;
    dateFormat?: DynamicValue<string>;
    dateRange: boolean;
    selectPageAction?: ActionValue;
}

export type ButtonActionEnum = "togglefilter" | "callaction";

export type ButtonStyleEnum = "default" | "primary" | "success" | "info" | "warning" | "danger";

export interface CustomButtonsType {
    caption: DynamicValue<string>;
    buttonAction: ButtonActionEnum;
    buttonStyle: ButtonStyleEnum;
    visibility?: DynamicValue<boolean>;
    onClickAction?: ActionValue;
}

export interface SearchFieldsPreviewType {
    caption: string;
    placeholder: string;
    fieldSource: FieldSourceEnum;
    controlType: ControlTypeEnum;
    attribute: string;
    association: string;
    optionsDs: {} | { caption: string } | { type: string } | null;
    captionAttribute: string;
    captionTemplate: string;
    matchEnabled: boolean;
    matchAttribute: string;
    matchOptionAttribute: string;
    allOptionsCaption: string;
    optionsLimit: number | null;
    optionsLazyLoad: boolean;
    optionsPageSize: number | null;
    optionsParentAssoc: string;
    cascadeEmptyBehavior: CascadeEmptyBehaviorEnum;
    dateFormat: string;
    dateRange: boolean;
    selectPageAction: {} | null;
}

export interface CustomButtonsPreviewType {
    caption: string;
    buttonAction: ButtonActionEnum;
    buttonStyle: ButtonStyleEnum;
    visibility: string;
    onClickAction: {} | null;
}

export interface DataGridTwoSearchBarContainerProps {
    name: string;
    class: string;
    style?: CSSProperties;
    tabIndex?: number;
    searchFields: SearchFieldsType[];
    fieldsPerRow: number;
    searchOnButtonClick: boolean;
    showSearchButton: boolean;
    showClearButton: boolean;
    showFilterButton: boolean;
    defaultShowFields: boolean;
    customButtons: CustomButtonsType[];
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
    searchOnButtonClick: boolean;
    showSearchButton: boolean;
    showClearButton: boolean;
    showFilterButton: boolean;
    defaultShowFields: boolean;
    customButtons: CustomButtonsPreviewType[];
    selectPageAction: {} | null;
    searchButtonCaption: string;
    clearButtonCaption: string;
    filterButtonCaption: string;
    allOptionsCaptionDefault: string;
}
