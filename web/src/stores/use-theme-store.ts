import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isPlatformEnabled } from "@/lib/platform";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: isPlatformEnabled() ? "light" : "dark",
            setTheme: (theme) => set({ theme }),
        }),
        { name: "infinite-canvas:theme_store" },
    ),
);
