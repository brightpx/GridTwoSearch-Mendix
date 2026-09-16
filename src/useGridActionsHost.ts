import { RefObject, useEffect, useState } from "react";

/** Render actions in the owning grid, aligned with its last search row. */
export function useGridActionsHost(rootRef: RefObject<HTMLDivElement | null>, visible: boolean): HTMLDivElement | null {
    const [host, setHost] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        const grid = root?.closest<HTMLElement>(".widget-datagrid");
        if (!root || !grid || !visible) {
            setHost(null);
            return;
        }
        const element = document.createElement("div");
        element.className = "widget-dg2-searchbar-top-actions";
        let topBar: HTMLElement | null = null;
        let frame = 0;
        let appliedOffset = 0;
        const align = () => {
            frame = 0;
            const cells = Array.from(root.querySelectorAll<HTMLElement>(
                ".widget-dg2-searchbar__fields > .widget-dg2-searchbar__row:last-child > .widget-dg2-searchbar__cell"
            ));
            const buttons = element.firstElementChild?.getBoundingClientRect();
            let offset = 0;
            if (buttons && cells.length > 0) {
                const bounds = cells.map(cell => cell.getBoundingClientRect());
                // Shift only when the theme places the top bar beside the fields.
                // Stacked layouts retain normal flow to avoid overlapping inputs.
                if (buttons.left >= Math.max(...bounds.map(rect => rect.right)) - 1) {
                    offset = Math.max(...bounds.map(rect => rect.bottom)) - (buttons.bottom - appliedOffset);
                }
            }
            appliedOffset = offset;
            element.style.setProperty("--dg2sb-actions-offset", `${offset}px`);
        };
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(align);
        };
        const resizeObserver = new ResizeObserver(schedule);
        resizeObserver.observe(root);
        resizeObserver.observe(element);
        const detach = () => {
            element.remove();
            if (topBar) {
                resizeObserver.unobserve(topBar);
                if (!topBar.querySelector(":scope > .widget-dg2-searchbar-top-actions")) {
                    topBar.classList.remove("widget-dg2-searchbar-top-bar");
                }
            }
        };
        const connect = () => {
            const next = Array.from(grid.children).find(child => child.classList.contains("widget-datagrid-top-bar")) as
                | HTMLElement
                | undefined;
            if ((next ?? null) === topBar) {
                return;
            }
            detach();
            topBar = next ?? null;
            if (topBar) {
                topBar.classList.add("widget-dg2-searchbar-top-bar");
                topBar.prepend(element);
                resizeObserver.observe(topBar);
            }
            setHost(topBar ? element : null);
            schedule();
        };
        connect();
        const mutationObserver = new MutationObserver(connect);
        mutationObserver.observe(grid, { childList: true });
        window.addEventListener("resize", schedule);
        root.addEventListener("animationend", schedule);
        return () => {
            mutationObserver.disconnect();
            detach();
            resizeObserver.disconnect();
            cancelAnimationFrame(frame);
            window.removeEventListener("resize", schedule);
            root.removeEventListener("animationend", schedule);
        };
    }, [rootRef, visible]);

    return visible ? host : null;
}
