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
                if (property.key === "matchEnabled") {
                    return isAssociation;
                }
                if (property.key === "matchAttribute" || property.key === "matchOptionAttribute") {
                    // The match attributes only apply while attribute match
                    // is enabled; hide them when the toggle is switched off.
                    return isAssociation && field?.matchEnabled !== false;
                }
                if (
                    property.key === "association" ||
                    property.key === "optionsDs" ||
                    property.key === "captionAttribute" ||
                    property.key === "captionTemplate"
                ) {
                    return isAssociation;
                }
                if (property.key === "allOptionsCaption" || property.key === "optionsParentAssoc") {
                    return isComboBox;
                }
                if (property.key === "optionsLimit") {
                    // Meaningless with lazy loading: paging by page size
                    // replaces the display cap, so hide the property instead
                    // of letting it look effective.
                    return isComboBox && field?.optionsLazyLoad !== true;
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

/**
 * Structure mode (Studio Pro "Structure mode" view) wireframe. Studio Pro
 * calls this instead of the React preview() in editorPreview.tsx, so without
 * it the widget shows only the default caption box. The wireframe mirrors the
 * runtime layout: a title bar with a field-count summary, search-field cells
 * (caption above an input-like box with a control-type marker) chunked into
 * rows by Fields per row, then the actions row with Filter + custom buttons
 * on the left and Search + Reset pushed to the right edge.
 */
export function getPreview(
    values: DataGridTwoSearchBarPreviewProps,
    isDarkMode: boolean,
    _version: number[]
): PreviewProps {
    const palette = isDarkMode
        ? {
              outerBg: "#252526",
              headerBg: "#2B3A4A",
              headerText: "#D6E4F0",
              label: "#9FB3C8",
              inputBg: "#1E1E1E",
              placeholder: "#8A8A8A",
              marker: "#7A8A99",
              muted: "#8A8A8A",
              btnDefaultBg: "#3A3A3A",
              btnDefaultText: "#D6D6D6",
              primary: "#2D6DA8",
              success: "#3E8E41",
              info: "#1E7A96",
              warning: "#B97A2A",
              danger: "#B04A47",
              onColored: "#FFFFFF"
          }
        : {
              outerBg: "#FFFFFF",
              headerBg: "#EEF2F7",
              headerText: "#33475B",
              label: "#5A6B7B",
              inputBg: "#FFFFFF",
              placeholder: "#9AA4AF",
              marker: "#7A8A99",
              muted: "#8A8A8A",
              btnDefaultBg: "#FFFFFF",
              btnDefaultText: "#4A4A4A",
              primary: "#337AB7",
              success: "#5CB85C",
              info: "#5BC0DE",
              warning: "#F0AD4E",
              danger: "#D9534F",
              onColored: "#FFFFFF"
          };

    const fields = values.searchFields ?? [];
    const buttons = values.customButtons ?? [];
    const perRow = Math.max(1, values.fieldsPerRow || 5);

    type FieldItem = DataGridTwoSearchBarPreviewProps["searchFields"][number];

    const filler = (grow: number): PreviewProps => ({
        type: "Container",
        grow,
        children: []
    });

    // Control-type marker shown at the right edge of each input box so the
    // wireframe hints what the field renders at runtime.
    const markerFor = (field: FieldItem): string => {
        if (field.controlType === "combobox") {
            return "▾";
        }
        if (field.controlType === "selectpage") {
            return "↗";
        }
        if (field.controlType === "datepicker") {
            return "date";
        }
        return "abc";
    };

    const placeholderFor = (field: FieldItem): string => {
        if (field.controlType === "combobox") {
            return field.allOptionsCaption || "-- all --";
        }
        if (field.controlType === "selectpage") {
            return "Select…";
        }
        if (field.controlType === "datepicker") {
            return field.dateFormat || "date";
        }
        return field.placeholder || "text";
    };

    // Input-like box: muted placeholder text on the left, control marker on
    // the right — reads as a text input in the wireframe.
    const inputBox = (field: FieldItem, grow: number): PreviewProps => ({
        type: "Container",
        grow,
        padding: 4,
        borders: true,
        borderWidth: 1,
        borderRadius: 3,
        backgroundColor: palette.inputBg,
        children: [
            {
                type: "RowLayout",
                columnSize: "grow",
                children: [
                    {
                        type: "Text",
                        content: placeholderFor(field),
                        fontColor: palette.placeholder,
                        fontSize: 9
                    },
                    filler(1),
                    {
                        type: "Text",
                        content: markerFor(field),
                        fontColor: palette.marker,
                        fontSize: 10,
                        bold: true
                    }
                ]
            }
        ]
    });

    // One search-field cell: small bold caption above the input box, like
    // the runtime label + control stack. Range date pickers draw two input
    // boxes side by side.
    const fieldCell = (field: FieldItem): PreviewProps => ({
        type: "Container",
        grow: 1,
        children: [
            {
                type: "Text",
                content: field.caption || "Search",
                fontColor: field.caption ? palette.label : palette.muted,
                fontSize: 9,
                bold: !!field.caption,
                italic: !field.caption
            },
            field.controlType === "datepicker" && field.dateRange
                ? {
                      type: "RowLayout",
                      columnSize: "grow",
                      children: [inputBox(field, 1), inputBox(field, 1)]
                  }
                : inputBox(field, 1)
        ]
    });

    const rows: PreviewProps[] = [];
    for (let i = 0; i < fields.length; i += perRow) {
        rows.push({
            type: "RowLayout",
            columnSize: "grow",
            children: fields.slice(i, i + perRow).map(fieldCell)
        });
    }

    // Bootstrap-like button colors so each custom button hints its runtime
    // style (primary/success/info/warning/danger/default).
    const buttonChip = (caption: string, style: string): PreviewProps => {
        const colored =
            style === "primary"
                ? palette.primary
                : style === "success"
                ? palette.success
                : style === "info"
                ? palette.info
                : style === "warning"
                ? palette.warning
                : style === "danger"
                ? palette.danger
                : null;
        return {
            type: "Container",
            grow: 0,
            padding: 4,
            borders: true,
            borderWidth: 1,
            borderRadius: 3,
            backgroundColor: colored ?? palette.btnDefaultBg,
            children: [
                {
                    type: "Text",
                    content: caption,
                    fontColor: colored ? palette.onColored : palette.btnDefaultText,
                    fontSize: 9,
                    bold: true
                }
            ]
        };
    };

    // Actions row: Filter + custom buttons on the left, Search + Reset on
    // the right (a grow filler pushes the right cluster to the edge).
    const leftCluster: PreviewProps[] = [];
    if (values.showFilterButton !== false) {
        leftCluster.push(buttonChip(values.filterButtonCaption || "Filter", "default"));
    }
    buttons.forEach((button, index) =>
        leftCluster.push(buttonChip(button.caption || `Button ${index + 1}`, button.buttonStyle || "default"))
    );
    const rightCluster: PreviewProps[] = [];
    if (values.searchOnButtonClick && values.showSearchButton !== false) {
        rightCluster.push(buttonChip(values.searchButtonCaption || "Search", "primary"));
    }
    if (values.showClearButton !== false) {
        rightCluster.push(buttonChip(values.clearButtonCaption || "Reset", "default"));
    }

    // Title bar with the widget name and a field-count summary, then the
    // field rows and the actions row.
    const children: PreviewProps[] = [
        {
            type: "RowLayout",
            columnSize: "grow",
            backgroundColor: palette.headerBg,
            padding: 4,
            children: [
                {
                    type: "Text",
                    content: "Data Grid Two Search Bar",
                    fontColor: palette.headerText,
                    fontSize: 10,
                    bold: true
                },
                filler(1),
                {
                    type: "Text",
                    content:
                        fields.length > 0
                            ? `${fields.length} field${fields.length === 1 ? "" : "s"}`
                            : "not configured",
                    fontColor: palette.muted,
                    fontSize: 9
                }
            ]
        },
        {
            type: "Container",
            padding: 6,
            backgroundColor: palette.outerBg,
            children:
                fields.length > 0
                    ? // Always draw the field rows: "Show fields by default"
                      // only affects the runtime initial collapsed state.
                      rows
                    : [
                          {
                              type: "Text",
                              content: "No search fields configured.",
                              fontColor: palette.muted,
                              italic: true,
                              fontSize: 9
                          }
                      ]
        }
    ];
    if (leftCluster.length > 0 || rightCluster.length > 0) {
        children.push({
            type: "RowLayout",
            columnSize: "grow",
            padding: 6,
            children: [...leftCluster, filler(1), ...rightCluster]
        });
    }

    return {
        type: "Container",
        borders: true,
        borderWidth: 1,
        borderRadius: 4,
        backgroundColor: palette.outerBg,
        children
    };
}

export function getCustomCaption(_values: DataGridTwoSearchBarPreviewProps, _platform: Platform): string {
    return "Data Grid Two Search Bar";
}
