import '@/polyfills';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { loadComputers, nudge } from '@/services/computers';
import { loadPhone } from '@/services/phone';
import { usePalette } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme();
  const p = usePalette();

  useEffect(() => {
    loadPhone();
    void loadComputers().finally(() => SplashScreen.hideAsync());
    // Coming back to the app: reconnect now instead of waiting out a backoff.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && nudge());
    return () => sub.remove();
  }, []);

  const base = scheme === 'light' ? DefaultTheme : DarkTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, background: p.paper, card: p.surface, text: p.ink, border: p.line, primary: p.accent },
  };

  return (
    <ThemeProvider value={theme}>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <Stack screenOptions={{ contentStyle: { backgroundColor: p.paper }, headerTintColor: p.accent, headerTitleStyle: { color: p.ink } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="chat/[id]" options={{ title: '', headerBackTitle: 'Chats' }} />
        <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair a computer' }} />
        <Stack.Screen name="new" options={{ presentation: 'formSheet', title: 'New chat', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }} />
      </Stack>
    </ThemeProvider>
  );
}
