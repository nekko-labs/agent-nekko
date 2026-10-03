import { Tabs } from 'expo-router';

import { Icon } from '@/ui/Icon';
import { usePalette } from '@/ui/theme';

/** Web preview build: a plain bottom tab bar standing in for the native one. */
export default function TabsLayout() {
  const p = usePalette();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.inkFaint,
        tabBarStyle: { backgroundColor: p.surface, borderTopColor: p.line, height: 68, paddingTop: 6, paddingBottom: 10 },
        sceneStyle: { backgroundColor: p.paper },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Chats', tabBarIcon: ({ color }) => <Icon name="chats" color={color} /> }} />
      <Tabs.Screen name="models" options={{ title: 'On this phone', tabBarIcon: ({ color }) => <Icon name="phone" color={color} /> }} />
      <Tabs.Screen name="computers" options={{ title: 'Computers', tabBarIcon: ({ color }) => <Icon name="computer" color={color} /> }} />
    </Tabs>
  );
}
