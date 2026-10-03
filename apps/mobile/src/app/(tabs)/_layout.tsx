import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useStore } from '@/lib/store';
import { computers } from '@/services/computers';
import { usePalette } from '@/ui/theme';

/** Native tab bar: Liquid Glass on iOS, Material bottom navigation on Android. */
export default function TabsLayout() {
  const p = usePalette();
  const denied = useStore(computers, (s) => !!s.denied);
  return (
    <NativeTabs backgroundColor={p.surface} indicatorColor={p.accentSoft} tintColor={p.accent} labelStyle={{ selected: { color: p.accent } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="forum" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="models">
        <NativeTabs.Trigger.Label>On this phone</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="iphone" md="smartphone" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Label>Computers</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'desktopcomputer', selected: 'desktopcomputer' }} md="computer" />
        {denied ? <NativeTabs.Trigger.Badge>!</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
