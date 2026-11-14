import { Button, theme } from 'antd';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUiPreferences } from '../state/ui-preferences.store';
import { setReducedMotion, setSystemDarkMode } from '../../test/media';
import { renderWithProviders } from '../../test/render';

/** Exposes what Ant Design resolved for the current theme, the way any component sees it. */
function Probe() {
  const { token } = theme.useToken();
  return (
    <>
      <output data-testid="surface">{token.colorBgContainer}</output>
      <output data-testid="motion">{String(token.motion)}</output>
      <output data-testid="font">{token.fontFamily}</output>
      <Button>Action</Button>
    </>
  );
}

const root = document.documentElement;
const surface = () => screen.getByTestId('surface').textContent;

describe('ThemeProvider: theme', () => {
  it('applies the light theme to the document and to Ant Design', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'light' } });
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(surface()).toBe('#ffffff');
  });

  it('applies the dark theme', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'dark' } });
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(surface()).not.toBe('#ffffff');
  });

  it('exposes theme colors as CSS variables for global styles', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'light' } });
    const light = root.style.getPropertyValue('--app-bg');
    expect(light).not.toBe('');

    act(() => useUiPreferences.getState().setThemeMode('dark'));
    expect(root.style.getPropertyValue('--app-bg')).not.toBe(light);
  });

  it('switches at runtime without remounting content', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'light' } });
    const button = screen.getByRole('button', { name: 'Action' });

    act(() => useUiPreferences.getState().setThemeMode('dark'));

    expect(root.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Action' })).toBe(button); // same DOM node: no duplicated layout
  });

  it('follows the operating system in "system" mode, including live changes', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'system' } });
    expect(root.dataset.theme).toBe('light');

    setSystemDarkMode(true);
    expect(root.dataset.theme).toBe('dark');

    setSystemDarkMode(false);
    expect(root.dataset.theme).toBe('light');
  });

  it('ignores the operating system when a theme is chosen explicitly', () => {
    renderWithProviders(<Probe />, { preferences: { themeMode: 'light' } });
    setSystemDarkMode(true);
    expect(root.dataset.theme).toBe('light');
  });

  it('turns animation off when the user prefers reduced motion', () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId('motion').textContent).toBe('true');
    setReducedMotion(true);
    expect(screen.getByTestId('motion').textContent).toBe('false');
  });
});

describe('ThemeProvider: language and direction', () => {
  it('renders English left-to-right', () => {
    renderWithProviders(<Probe />, { preferences: { locale: 'en' } });
    expect(root.lang).toBe('en');
    expect(root.dir).toBe('ltr');
    expect(screen.getByRole('button', { name: 'Action' }).className).not.toMatch(/-rtl/);
  });

  it('renders Persian right-to-left, for the document and for Ant Design components', () => {
    renderWithProviders(<Probe />, { preferences: { locale: 'fa' } });
    expect(root.lang).toBe('fa');
    expect(root.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: 'Action' }).className).toMatch(/-rtl/);
  });

  it('flips direction at runtime with a single layout (same DOM node, no copy)', () => {
    renderWithProviders(<Probe />, { preferences: { locale: 'en' } });
    const button = screen.getByRole('button', { name: 'Action' });

    act(() => useUiPreferences.getState().setLocale('fa'));

    expect(root.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: 'Action' })).toBe(button);
    expect(button.className).toMatch(/-rtl/);

    act(() => useUiPreferences.getState().setLocale('en'));
    expect(root.dir).toBe('ltr');
    expect(button.className).not.toMatch(/-rtl/);
  });

  it('switches the font stack with the language', () => {
    renderWithProviders(<Probe />, { preferences: { locale: 'en' } });
    expect(screen.getByTestId('font').textContent).not.toContain('Vazirmatn');
    expect(root.style.getPropertyValue('--app-font-family')).not.toContain('Vazirmatn');

    act(() => useUiPreferences.getState().setLocale('fa'));
    expect(screen.getByTestId('font').textContent).toContain('Vazirmatn');
    expect(root.style.getPropertyValue('--app-font-family')).toContain('Vazirmatn');
  });
});
