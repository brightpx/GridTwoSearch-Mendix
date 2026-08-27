import { createContext, useContext } from "react";

/**
 * Typed accessor for the global filter context shared by Data grid 2 and its
 * filter widgets. Data grid 2 publishes a React context at this window path
 * and wraps the widgets placed in its "Filters placeholder" area with a
 * provider of that context.
 */
const CONTEXT_OBJECT_PATH = "com.mendix.widgets.web.filterable.filterContext.v2" as const;

export interface FilterAPIError {
    message: string;
    code: "ENOCONTEXT";
}

/**
 * Minimal structural typing for the parts of FilterAPI we rely on, so we do
 * not need to import from @mendix/widget-plugin-filtering (which is not a
 * published dependency).
 */
export interface ObservableFilterHost {
    observe(key: string, filter: FilterLike): void;
    unobserve(key: string): void;
}

export interface DirectProvider {
    filterObserver: ObservableFilterHost;
}

export interface FilterAPI {
    version: number;
    parentChannelName: string;
    provider: { value?: DirectProvider; error?: unknown };
    filterObserver: ObservableFilterHost;
}

/**
 * A filter store as expected by CustomFilterHost.observe(). Plain object — no
 * mobx required on our side; the host reads `condition` when recomputing.
 */
export interface FilterLike {
    condition: unknown;
    toJSON(): unknown;
    fromJSON(data: unknown): void;
    fromViewState(data: unknown): void;
    setup?(): void | undefined;
}

interface WindowWithFilterContext {
    [CONTEXT_OBJECT_PATH]?: unknown;
}

function getGlobalContext(): unknown {
    return (window as unknown as WindowWithFilterContext)[CONTEXT_OBJECT_PATH];
}

export interface UseFilterAPIResult {
    api: FilterAPI | null;
    error: FilterAPIError | null;
}

/**
 * Equivalent of useFilterAPI() from @mendix/widget-plugin-filtering: reads
 * the shared context object from window and consumes it with useContext.
 */
export function useFilterAPI(): UseFilterAPIResult {
    const context = getGlobalContext();
    // useContext must run unconditionally on every render; when the shared
    // context object is missing we consume a stable no-op context instead.
    const Context = (context as import("react").Context<FilterAPI | null>) ?? NoopContext;
    const api = useContext(Context);
    if (!context || !api) {
        return {
            api: null,
            error: {
                code: "ENOCONTEXT",
                message:
                    "Data Grid Two Search Bar must be placed inside the 'Filters placeholder' area of a Data grid 2 widget."
            }
        };
    }
    return { api, error: null };
}

/** Fallback context used when the widget is not inside a filterable host. */
const NoopContext = createContext<FilterAPI | null>(null);
