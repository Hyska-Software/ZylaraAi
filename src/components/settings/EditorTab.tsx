import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input, SegmentedControl, Slider, Switch } from '@/components/ui';
import {
  EDITOR_FONT_FAMILY_MAX_LENGTH,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_LINE_HEIGHT_MAX,
  EDITOR_LINE_HEIGHT_MIN,
  EDITOR_TAB_SIZE_MAX,
  EDITOR_TAB_SIZE_MIN,
  normalizeEditorFontFamily,
  normalizeEditorFontSize,
  normalizeEditorLineHeight,
  normalizeEditorTabSize,
  normalizeEditorTheme,
} from '@/lib/editorSettings';
import { useAppStore, useUiStore } from '@/lib/store';
import { SettingsBlock, SettingRow, SettingsSection } from './shared';

/** Settings › Editor: typography and palette of the Code file/diff viewers. */
export function EditorTab() {
  const { t } = useTranslation('settings');
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const wrap = useUiStore((state) => state.codeFileWrap);
  const setWrap = useUiStore((state) => state.setCodeFileWrap);

  const savedFontFamily = normalizeEditorFontFamily(settings.editorFontFamily);
  const [fontFamily, setFontFamily] = useState(savedFontFamily);
  useEffect(() => {
    setFontFamily(savedFontFamily);
  }, [savedFontFamily]);

  const theme = normalizeEditorTheme(settings.editorTheme);
  const fontSize = normalizeEditorFontSize(settings.editorFontSize);
  const lineHeight = normalizeEditorLineHeight(settings.editorLineHeight);
  const tabSize = normalizeEditorTabSize(settings.editorTabSize);
  const lineNumbers = settings.editorLineNumbers !== false;

  const themeOptions = [
    { value: 'app', label: t('editor.theme.app') },
    { value: 'light', label: t('editor.theme.light') },
    { value: 'dark', label: t('editor.theme.dark') },
  ];

  const commitFontFamily = () => {
    const value = normalizeEditorFontFamily(fontFamily);
    if (value !== savedFontFamily) void saveSettings({ editorFontFamily: value });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title={t('editor.appearance.title')}
        description={t('editor.appearance.description')}
      >
        <SettingRow label={t('editor.theme.label')} description={t('editor.theme.description')}>
          <SegmentedControl
            size="sm"
            options={themeOptions}
            value={theme}
            onChange={(value) => void saveSettings({ editorTheme: normalizeEditorTheme(value) })}
            ariaLabel={t('editor.theme.aria')}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t('editor.fontFamily.label')}
          description={t('editor.fontFamily.description')}
        >
          <Input
            value={fontFamily}
            maxLength={EDITOR_FONT_FAMILY_MAX_LENGTH}
            aria-label={t('editor.fontFamily.aria')}
            placeholder={t('editor.fontFamily.placeholder')}
            onChange={(event) => setFontFamily(event.target.value)}
            onBlur={commitFontFamily}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitFontFamily();
            }}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t('editor.fontSize.label')}
          description={t('editor.fontSize.description')}
        >
          <Slider
            min={EDITOR_FONT_SIZE_MIN}
            max={EDITOR_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            valueLabel={`${fontSize}px`}
            onValueChange={(value) => void saveSettings({ editorFontSize: normalizeEditorFontSize(value) })}
            aria-label={t('editor.fontSize.aria')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('editor.reading.title')}
        description={t('editor.reading.description')}
      >
        <SettingRow
          vertical
          label={t('editor.lineHeight.label')}
          description={t('editor.lineHeight.description')}
        >
          <Slider
            min={EDITOR_LINE_HEIGHT_MIN}
            max={EDITOR_LINE_HEIGHT_MAX}
            step={0.1}
            value={lineHeight}
            valueLabel={lineHeight.toFixed(1)}
            onValueChange={(value) =>
              void saveSettings({ editorLineHeight: normalizeEditorLineHeight(value) })
            }
            aria-label={t('editor.lineHeight.aria')}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t('editor.tabSize.label')}
          description={t('editor.tabSize.description')}
        >
          <Slider
            min={EDITOR_TAB_SIZE_MIN}
            max={EDITOR_TAB_SIZE_MAX}
            step={1}
            value={tabSize}
            valueLabel={`${tabSize}`}
            onValueChange={(value) => void saveSettings({ editorTabSize: normalizeEditorTabSize(value) })}
            aria-label={t('editor.tabSize.aria')}
          />
        </SettingRow>

        <SettingsBlock>
          <Switch
            checked={lineNumbers}
            onCheckedChange={(checked) => void saveSettings({ editorLineNumbers: checked })}
            aria-label={t('editor.lineNumbers.aria')}
            label={t('editor.lineNumbers.label')}
            description={t('editor.lineNumbers.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={wrap}
            onCheckedChange={setWrap}
            aria-label={t('editor.wrap.aria')}
            label={t('editor.wrap.label')}
            description={t('editor.wrap.description')}
          />
        </SettingsBlock>
      </SettingsSection>
    </div>
  );
}
