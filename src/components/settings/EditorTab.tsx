import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input, SegmentedControl, Slider, Switch } from '@/components/ui';
import {
  EDITOR_AUTO_SAVE_DELAY_MAX,
  EDITOR_AUTO_SAVE_DELAY_MIN,
  EDITOR_FONT_FAMILY_MAX_LENGTH,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_LINE_HEIGHT_MAX,
  EDITOR_LINE_HEIGHT_MIN,
  EDITOR_TAB_SIZE_MAX,
  EDITOR_TAB_SIZE_MIN,
  normalizeEditorAutoSave,
  normalizeEditorAutoSaveDelay,
  normalizeEditorFontFamily,
  normalizeEditorFontSize,
  normalizeEditorLineHeight,
  normalizeEditorTabSize,
  normalizeEditorTheme,
  resolveEditorFlag,
} from '@/lib/editorSettings';
import { useAppStore, useUiStore } from '@/lib/store';
import type { Settings } from '@/lib/types';
import { SettingsBlock, SettingRow, SettingsSection } from './shared';

/** Settings › Editor: typography, indentation, saving and editing behavior. */
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
  const insertSpaces = resolveEditorFlag(settings.editorInsertSpaces, 'insertSpaces');
  const detectIndentation = resolveEditorFlag(
    settings.editorDetectIndentation,
    'detectIndentation',
  );
  const autoIndent = resolveEditorFlag(settings.editorAutoIndent, 'autoIndent');
  const autoCloseBrackets = resolveEditorFlag(
    settings.editorAutoCloseBrackets,
    'autoCloseBrackets',
  );
  const trimTrailingWhitespace = resolveEditorFlag(
    settings.editorTrimTrailingWhitespace,
    'trimTrailingWhitespace',
  );
  const insertFinalNewline = resolveEditorFlag(
    settings.editorInsertFinalNewline,
    'insertFinalNewline',
  );
  const highlight = resolveEditorFlag(settings.editorHighlight, 'highlight');
  const fontLigatures = resolveEditorFlag(settings.editorFontLigatures, 'fontLigatures');
  const autoSave = normalizeEditorAutoSave(settings.editorAutoSave);
  const autoSaveDelay = normalizeEditorAutoSaveDelay(settings.editorAutoSaveDelay);

  const themeOptions = [
    { value: 'app', label: t('editor.theme.app') },
    { value: 'light', label: t('editor.theme.light') },
    { value: 'dark', label: t('editor.theme.dark') },
  ];
  const autoSaveOptions = [
    { value: 'off', label: t('editor.autoSave.off') },
    { value: 'delay', label: t('editor.autoSave.delay') },
    { value: 'blur', label: t('editor.autoSave.blur') },
  ];

  const commitFontFamily = () => {
    const value = normalizeEditorFontFamily(fontFamily);
    if (value !== savedFontFamily) void saveSettings({ editorFontFamily: value });
  };

  const restoreDefaults = () => {
    const defaults: Partial<Settings> = {
      editorTheme: 'app',
      editorFontFamily: '',
      editorFontSize: 12,
      editorLineHeight: 1.7,
      editorTabSize: 2,
      editorLineNumbers: true,
      editorAutoSave: 'off',
      editorAutoSaveDelay: 800,
      editorInsertSpaces: true,
      editorDetectIndentation: true,
      editorAutoIndent: true,
      editorAutoCloseBrackets: true,
      editorTrimTrailingWhitespace: false,
      editorInsertFinalNewline: true,
      editorHighlight: true,
      editorFontLigatures: false,
    };
    setFontFamily('');
    void saveSettings(defaults);
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

        <SettingsBlock>
          <Switch
            checked={fontLigatures}
            onCheckedChange={(checked) => void saveSettings({ editorFontLigatures: checked })}
            aria-label={t('editor.fontLigatures.aria')}
            label={t('editor.fontLigatures.label')}
            description={t('editor.fontLigatures.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={highlight}
            onCheckedChange={(checked) => void saveSettings({ editorHighlight: checked })}
            aria-label={t('editor.highlight.aria')}
            label={t('editor.highlight.label')}
            description={t('editor.highlight.description')}
          />
        </SettingsBlock>
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

      <SettingsSection
        title={t('editor.indentation.title')}
        description={t('editor.indentation.description')}
      >
        <SettingsBlock>
          <Switch
            checked={insertSpaces}
            onCheckedChange={(checked) => void saveSettings({ editorInsertSpaces: checked })}
            aria-label={t('editor.insertSpaces.aria')}
            label={t('editor.insertSpaces.label')}
            description={t('editor.insertSpaces.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={detectIndentation}
            onCheckedChange={(checked) =>
              void saveSettings({ editorDetectIndentation: checked })
            }
            aria-label={t('editor.detectIndentation.aria')}
            label={t('editor.detectIndentation.label')}
            description={t('editor.detectIndentation.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={autoIndent}
            onCheckedChange={(checked) => void saveSettings({ editorAutoIndent: checked })}
            aria-label={t('editor.autoIndent.aria')}
            label={t('editor.autoIndent.label')}
            description={t('editor.autoIndent.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={autoCloseBrackets}
            onCheckedChange={(checked) =>
              void saveSettings({ editorAutoCloseBrackets: checked })
            }
            aria-label={t('editor.autoCloseBrackets.aria')}
            label={t('editor.autoCloseBrackets.label')}
            description={t('editor.autoCloseBrackets.description')}
          />
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        title={t('editor.saving.title')}
        description={t('editor.saving.description')}
      >
        <SettingRow
          label={t('editor.autoSave.label')}
          description={t('editor.autoSave.description')}
        >
          <SegmentedControl
            size="sm"
            options={autoSaveOptions}
            value={autoSave}
            onChange={(value) =>
              void saveSettings({ editorAutoSave: normalizeEditorAutoSave(value) })
            }
            ariaLabel={t('editor.autoSave.aria')}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t('editor.autoSaveDelay.label')}
          description={t('editor.autoSaveDelay.description')}
        >
          <Slider
            min={EDITOR_AUTO_SAVE_DELAY_MIN}
            max={EDITOR_AUTO_SAVE_DELAY_MAX}
            step={100}
            value={autoSaveDelay}
            valueLabel={`${(autoSaveDelay / 1000).toFixed(1)}s`}
            disabled={autoSave !== 'delay'}
            onValueChange={(value) =>
              void saveSettings({ editorAutoSaveDelay: normalizeEditorAutoSaveDelay(value) })
            }
            aria-label={t('editor.autoSaveDelay.aria')}
          />
        </SettingRow>

        <SettingsBlock>
          <Switch
            checked={trimTrailingWhitespace}
            onCheckedChange={(checked) =>
              void saveSettings({ editorTrimTrailingWhitespace: checked })
            }
            aria-label={t('editor.trimTrailingWhitespace.aria')}
            label={t('editor.trimTrailingWhitespace.label')}
            description={t('editor.trimTrailingWhitespace.description')}
          />
        </SettingsBlock>

        <SettingsBlock>
          <Switch
            checked={insertFinalNewline}
            onCheckedChange={(checked) =>
              void saveSettings({ editorInsertFinalNewline: checked })
            }
            aria-label={t('editor.insertFinalNewline.aria')}
            label={t('editor.insertFinalNewline.label')}
            description={t('editor.insertFinalNewline.description')}
          />
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        title={t('editor.restore.title')}
        description={t('editor.restore.description')}
      >
        <div className="flex justify-end py-1">
          <Button variant="secondary" size="sm" onClick={restoreDefaults}>
            {t('editor.restore.action')}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
