import { DataGridTwoSearchBarPreviewProps } from "../typings/DataGridTwoSearchBarProps";

export type Platform = "web" | "desktop";

export type Properties = PropertyGroup[];

type PropertyGroup = {
    caption: string;
    propertyGroups?: PropertyGroup[];
    properties?: Property[];
};

type Property = {
    key: string;
    caption: string;
    description?: string;
    objectHeaders?: string[]; // used for customizing object grids
    objects?: ObjectProperties[];
    properties?: Properties[];
};

type ObjectProperties = {
    properties: PropertyGroup[];
    captions?: string[]; // used for customizing object grids
};

export type Problem = {
    property?: string; // key of the property, at which the problem exists
    severity?: "error" | "warning" | "deprecation"; // default = "error"
    message: string; // description of the problem
    studioMessage?: string; // studio-specific message, defaults to message
    url?: string; // link with more information about the problem
    studioUrl?: string; // studio-specific link
};

type BaseProps = {
    type: "Image" | "Container" | "RowLayout" | "Text" | "DropZone" | "Selectable" | "Datasource";
    grow?: number; // optionally sets a growth factor if used in a layout (default = 1)
};

type ImageProps = BaseProps & {
    type: "Image";
    document?: string; // svg image
    data?: string; // base64 image
    property?: object; // widget image property object from Values API
    width?: number; // sets a fixed maximum width
    height?: number; // sets a fixed maximum height
};

type ContainerProps = BaseProps & {
    type: "Container" | "RowLayout";
    children: PreviewProps[]; // any other preview element
    borders?: boolean; // sets borders around the layout to visually group its children
    borderRadius?: number; // integer. Can be used to create rounded borders
    backgroundColor?: string; // HTML color, formatted #RRGGBB
    borderWidth?: number; // sets the border width
    padding?: number; // integer. adds padding around the container
};

type RowLayoutProps = ContainerProps & {
    type: "RowLayout";
    columnSize?: "fixed" | "grow"; // default is fixed
};

type TextProps = BaseProps & {
    type: "Text";
    content: string; // text that should be shown
    fontSize?: number; // sets the font size
    fontColor?: string; // HTML color, formatted #RRGGBB
    bold?: boolean;
    italic?: boolean;
};

type DropZoneProps = BaseProps & {
    type: "DropZone";
    property: object; // widgets property object from Values API
    placeholder: string; // text to be shown inside the dropzone when empty
    showDataSourceHeader?: boolean; // true by default. Toggles whether to show a header containing information about the datasource
};

type SelectableProps = BaseProps & {
    type: "Selectable";
    object: object; // object property instance from the Value API
    child: PreviewProps; // any type of preview property to visualize the object instance
};

type DatasourceProps = BaseProps & {
    type: "Datasource";
    property: object | null; // datasource property object from Values API
    child?: PreviewProps; // any type of preview property component (optional)
};

export type PreviewProps =
    | ImageProps
    | ContainerProps
    | RowLayoutProps
    | TextProps
    | DropZoneProps
    | SelectableProps
    | DatasourceProps;

/**
 * Per search-field item: show only the property sections relevant to the
 * field's Filter on (attribute vs association) and Control type settings.
 * Hiding is done per object entry (via `objects`), so hidden required
 * properties are not validated by Studio Pro.
 *
 * Section visibility matrix (section caption -> condition):
 * - General:            always
 * - Attribute:          attribute source, except Select page controls
 * - Association:        association source, Combo box or Select page only
 * - Combo box options:  Combo box controls only
 * - Date picker:        attribute source + Date picker controls only
 * - Select page:        association source + Select page controls only
 */
export function getProperties(
    values: DataGridTwoSearchBarPreviewProps,
    defaultProperties: Properties /* , target: Platform*/
): Properties {
    filterGroups(defaultProperties, values.searchFields ?? [], values.customButtons ?? []);
    return defaultProperties;
}

function filterGroups(
    groups: PropertyGroup[],
    fields: DataGridTwoSearchBarPreviewProps["searchFields"],
    buttons: DataGridTwoSearchBarPreviewProps["customButtons"]
): void {
    for (const group of groups) {
        if (group.properties) {
            for (const property of group.properties) {
                if (property.key === "searchFields" && property.objects) {
                    // One object entry per search field item.
                    property.objects.forEach((object, objectIndex) => {
                        const field = fields[objectIndex] ?? fields[fields.length - 1];
                        filterFieldGroup(object.properties, field);
                    });
                }
                if (property.key === "customButtons" && property.objects) {
                    // One object entry per custom button item.
                    property.objects.forEach((object, objectIndex) => {
                        const button = buttons[objectIndex] ?? buttons[buttons.length - 1];
                        filterButtonGroup(object.properties, button);
                    });
                }
            }
        }
        for (const sub of group.propertyGroups ?? []) {
            filterGroups([sub], fields, buttons);
        }
    }
}

/**
 * Per custom-button item: the Action section (On click action) only makes
 * sense when Action = Call an action; hide it for Show/hide filter buttons.
 */
function filterButtonGroup(
    groups: PropertyGroup[],
    button: DataGridTwoSearchBarPreviewProps["customButtons"][number] | undefined
): void {
    const isCallAction = button?.buttonAction === "callaction";
    for (const group of [...groups]) {
        if (group.caption === "Action" && !isCallAction) {
            const index = groups.indexOf(group);
            if (index >= 0) {
                groups.splice(index, 1);
            }
        }
    }
}

function filterFieldGroup(
    groups: PropertyGroup[],
    field: DataGridTwoSearchBarPreviewProps["searchFields"][number]
): void {
    const isAssociation = field?.fieldSource === "association";
    const controlType = field?.controlType ?? "textbox";
    const isComboBox = controlType === "combobox";
    const isSelectPage = controlType === "selectpage";
    const isDatePicker = controlType === "datepicker";

    // Section caption -> whether the whole group stays visible for this field.
    const sectionVisible: Record<string, boolean> = {
        General: true,
        Attribute: !isAssociation && !isSelectPage,
        Association: isAssociation && (isComboBox || isSelectPage),
        "Combo box options": isComboBox,
        "Date picker": !isAssociation && isDatePicker,
        "Select page": isAssociation && isSelectPage
    };

    // Iterate a snapshot so splicing hidden sections out of `groups` cannot
    // skip the element following a removed one.
    for (const group of [...groups]) {
        if (group.caption && sectionVisible[group.caption] === false) {
            // Whole section irrelevant to this field's configuration: drop it
            // entirely so no empty group header remains in Studio Pro.
            const index = groups.indexOf(group);
            if (index >= 0) {
                groups.splice(index, 1);
            }
            continue;
        }
        if (group.properties) {
            group.properties = group.properties.filter(property => {
                if (property.key === "attribute") {
                    return !isAssociation;
                }
                if (
                    property.key === "association" ||
                    property.key === "optionsDs" ||
                    property.key === "captionAttribute"
                ) {
                    return isAssociation;
                }
                if (
                    property.key === "allOptionsCaption" ||
                    property.key === "optionsLimit" ||
                    property.key === "optionsParentAssoc"
                ) {
                    return isComboBox;
                }
                if (property.key === "dateFormat" || property.key === "dateRange") {
                    return !isAssociation && isDatePicker;
                }
                if (property.key === "selectPageAction") {
                    return isAssociation && isSelectPage;
                }
                return true;
            });
        }
        for (const sub of group.propertyGroups ?? []) {
            filterFieldGroup([sub], field);
        }
    }
}

// export function check(_values: DataGridTwoSearchBarPreviewProps): Problem[] {
//     const errors: Problem[] = [];
//     // Add errors to the above array to check in Studio and Studio Pro.
//     /* Example
//     if (values.myProperty !== "custom") {
//         errors.push({
//             property: `myProperty`,
//             message: `The value of 'myProperty' is different of 'custom'.`,
//             url: "https://github.com/myrepo/mywidget"
//         });
//     }
//     */
//     return errors;
// }

// export function getPreview(values: DataGridTwoSearchBarPreviewProps, isDarkMode: boolean, version: number[]): PreviewProps {
//     // Customize your pluggable widget appearance for Studio Pro.
//     return {
//         type: "Container",
//         children: []
//     }
// }

// export function getCustomCaption(values: DataGridTwoSearchBarPreviewProps, platform: Platform): string {
//     return "DataGridTwoSearchBar";
// }
