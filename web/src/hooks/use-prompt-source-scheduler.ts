import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { refreshDueSources } from "@/services/api/prompts";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const CHECK_INTERVAL_MS = 60_000;

/** Periodically update only the sources whose last successful refresh is due. */
export function usePromptSourceScheduler(enabled = true) {
    const queryClient = useQueryClient();
    const intervalMinutes = usePromptSourceStore((state) => state.schedule.intervalMinutes);

    useEffect(() => {
        // 提示词库关闭时不在后台请求 GitHub 上的提示词源。
        if (!enabled || !intervalMinutes) return;
        let running = false;
        const tick = async () => {
            if (running) return;
            const { updateSchedule } = usePromptSourceStore.getState();
            running = true;
            try {
                const result = await refreshDueSources(intervalMinutes * 60_000);
                if (!result.results.length) return;
                updateSchedule("lastFetchedAt", new Date().toISOString());
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["prompt-source-statuses"] }),
                ]);
            } catch {
                // Per-source errors are stored in source state and retried during the next check cycle.
            } finally {
                running = false;
            }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), CHECK_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [enabled, intervalMinutes, queryClient]);
}
