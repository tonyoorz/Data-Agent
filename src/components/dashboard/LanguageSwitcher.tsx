import { useTranslation } from "react-i18next";

import i18n, { languageStorageKey, supportedLanguages, type AppLanguage } from "@/i18n";
import { cn } from "@/lib/utils";

const languageLabels: Record<AppLanguage, string> = {
  "zh-CN": "中文",
  "en-US": "EN",
};

function getCurrentLanguage(): AppLanguage {
  return supportedLanguages.includes(i18n.resolvedLanguage as AppLanguage)
    ? (i18n.resolvedLanguage as AppLanguage)
    : "zh-CN";
}

const LanguageSwitcher = () => {
  const { t } = useTranslation("common");
  const currentLanguage = getCurrentLanguage();

  const handleLanguageChange = (language: AppLanguage) => {
    if (language === currentLanguage) {
      return;
    }

    window.localStorage.setItem(languageStorageKey, language);
    void i18n.changeLanguage(language);
  };

  return (
    <div className="inline-flex rounded-lg border border-border bg-background p-0.5 shadow-sm" aria-label="Language switcher">
      {supportedLanguages.map((language) => {
        const isActive = language === currentLanguage;
        const label = language === "zh-CN" ? t("language.chinese") : t("language.english");

        return (
          <button
            key={language}
            type="button"
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => handleLanguageChange(language)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs font-semibold transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {languageLabels[language]}
          </button>
        );
      })}
    </div>
  );
};

export default LanguageSwitcher;