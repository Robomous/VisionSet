/**
 * The groups of the workspace's Settings page. Each id is a URL segment
 * (`/settings/:section`), and a group joins this list only when it has content,
 * so the page never links to a section that would render nothing.
 */
export type SettingsSection = "about";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["about"];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "about";

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}
