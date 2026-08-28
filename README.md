# DataGridTwoSearchBar

A configurable search bar for [Data grid 2](https://docs.mendix.com/appstore/widgets/data-grid-2/): generates one search control per configured column (attributes and associations) and applies the filters to the linked Data grid 2 data source through the shared filter context.

## Features

- **One control per search field** — configure a list of search fields; each field filters one attribute or association of the Data grid 2 data source entity.
- **Control types**
  - *Text box* — free-text `contains` search on String attributes; exact `equals` match on numeric attributes (Decimal, Integer, Long, AutoNumber).
  - *Combo box* — dropdown of selectable objects for association fields (options come from the field's **Options data source**), or Enum/Boolean value selection for attribute fields. Supports type-to-narrow with a display limit and a custom "all options" caption.
  - *Date picker* — native browser date input, or a text box following a custom format (e.g. `dd/MM/yyyy`) with a calendar picker overlay. Optional **range search** (Date from / Date to, inclusive calendar days).
  - *Select page* — opens a picker page and captures the picked object **without any database writes** (see [Select page setup](#select-page-setup)).
- **Cascading combo boxes** — limit a child field's options to objects linked to the parent field's selection (e.g. Province → District → Subdistrict).
- **Deferred search** — optionally hold edits locally and only filter the grid after clicking **Search**; **Reset** always applies immediately.
- **Custom buttons** — add any number of extra buttons to the actions row. Each button either toggles the search-fields area (Show/hide filter) or calls a microflow/nanoflow (configure via **On click** → *Call a microflow* / *Call a nanoflow*), with a selectable Bootstrap style.
- **Configurable action buttons** — show or hide the built-in **Search**, **Reset**, and **Filter** buttons per widget instance.
- **Filter open/close animation** — the search-fields area animates in and out (260 ms ease-out slide/fade).
- **Layout options** — fields per row, collapsible filter area, customizable button captions and "all options" caption.

## Usage

1. Place the widget inside the **Filters** placeholder of a Data grid 2.
2. Set **Data source** to the Data grid 2's data source.
3. Add entries to **Search fields** — one per search control:
   - Choose **Filter on** (attribute or association) and the **Control type**.
   - For association fields, configure the **Options data source** (the list of selectable objects) and optionally the **Option caption attribute**.
4. Optional: set **Fields per row**, enable **Search on button click**, or customize the button captions in **Texts**.

### Date picker

- Leave **Date format** empty to use the browser's native date input.
- Set a format such as `dd/MM/yyyy` to render a text box with that token pattern (supported tokens: `dd`, `MM`, `yyyy`) plus a calendar picker button on the right; picking from the calendar fills the text box in the configured format.
- Enable **Search by range** to show two inputs (from/to). Either bound may be left empty.

### Select page setup

The Select page control shows the current selection with a clear (×) button and a diagonal-arrow (↗) button that opens the configured page. The picked object is reported back to the widget through a browser DOM event — **no helper entity, no database writes, and no interference between concurrent users**.

**1. Create a JavaScript action** (e.g. `JS_ReportPick` in your module):

- Parameter: `obj`, type **Object** (the entity shown in the picker page's grid, or Any).
- Return type: **Boolean** (or void).
- Code:

```javascript
export async function JS_ReportPick(obj) {
    window.dispatchEvent(new CustomEvent("mx-select-page-pick", {
        detail: { guid: obj.getGuid() }
    }));
    return true;
}
```

**2. Build the picker page:**

- A page with a Data grid (or List view) of the objects the user may pick.
- The row/button the user clicks calls a **nanoflow** (passing the clicked object as parameter) that:
  1. Calls the `JS_ReportPick` JavaScript action with the clicked object;
  2. Closes the page (**Close page** activity).

**3. Configure the widget:**

- Set the field's (or widget-level) **Select page action** to *Open page* → your picker page.
- The **Options data source** should list the selectable objects (used to resolve the picked object's caption and to build the filter literal). If the picked object is not yet in the options snapshot, the widget reloads the source once automatically.

The widget applies the picked object to the field's filter immediately after the event arrives; the selection is cleared when the arrow button is clicked again (starting a new choice) or via the × button.

## Properties reference

| Property | Description |
| --- | --- |
| Data source | Data source of the Data grid 2 this search bar filters. |
| Search fields | One entry per search control (see below). |
| Fields per row | Maximum number of search controls on one row. |
| Search on button click | Hold edits locally until the Search button is pressed. |
| Show search / reset / filter button | Hide any of the three built-in buttons by unchecking its box. |
| Show fields by default | Whether the search fields area starts expanded (checked) or collapsed (unchecked) on page load; the Filter button toggles it afterwards. |
| Custom buttons | Extra buttons; each has a caption, an action (Show/hide filter or Call an action) and a style. For *Call an action*, set **On click** to *Call a microflow* or *Call a nanoflow*. |
| Search / Reset / Filter button captions | Button texts. |
| All options caption (default) | Caption of the "no filter" entry in combo boxes. |

Per search field:

| Property | Description |
| --- | --- |
| Caption / Placeholder | Label above and placeholder inside the control. |
| Filter on | Attribute or association. |
| Control type | Text box, Combo box, Select page, or Date picker. |
| Attribute | The attribute to filter (attribute fields). |
| Association / Options data source / Option caption attribute | Association to filter and the selectable objects (association fields). |
| All options caption / Options display limit / Options parent filter | Combo box behavior and cascading. |
| Date format / Search by range | Date picker behavior. |
| Select page action | Open page action for Select page fields (falls back to the widget-level action). |

## Demo project

No demo project yet — the widget was developed and verified against a local Mendix 11 test project.

## Issues, suggestions and feature requests

Please use the project's issue tracker.

## Development and contribution

1. Install NPM package dependencies by using: `npm install`. If you use NPM v7.x.x, which can be checked by executing `npm -v`, execute: `npm install --legacy-peer-deps`.
1. Run `npm start` to watch for code changes. On every change:
    - the widget will be bundled;
    - the bundle will be included in a `dist` folder in the root directory of the project;
    - the bundle will be included in the `deployment` and `widgets` folder of the Mendix test project.

Manual build and deploy used during development:

```powershell
npm run build
Copy-Item "dist\tmp\widgets\tbn\datagridtwosearchbar\*" "..\deployment\web\widgets\tbn\datagridtwosearchbar\" -Force
Copy-Item "dist\1.0.0\tbn.DataGridTwoSearchBar.mpk" "..\widgets\tbn.DataGridTwoSearchBar.mpk" -Force
```

Note: the filter stores are plain classes (no mobx) and re-register with the grid's filter host after every mutation; see `src/filtering/stores.ts` for details.
