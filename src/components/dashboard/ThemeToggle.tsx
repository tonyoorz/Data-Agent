import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

const ThemeToggle = () => {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation("common");
  // next-themes reads from localStorage; avoid hydration mismatch by rendering
  // after mount, mirroring the LanguageSwitcher's client-only behavior.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = mounted ? (theme === "dark" ? "dark" : "light") : "light";

  const options = [
    { key: "light" as const, icon: Sun, label: t("theme.light") },
    { key: "dark" as const, icon: Moon, label: t("theme.dark") },
  ];

  return (
    <div
      className="inline-flex rounded-lg border border-border bg-background p-0.5 shadow-sm"
      role="group"
      aria-label={t("theme.toggle")}
    >
      {options.map(({ key, icon: Icon, label }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => setTheme(key)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
};

export default ThemeToggle;
