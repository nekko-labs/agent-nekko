import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

/** One name per idea, mapped to SF Symbols on iOS and Material Symbols elsewhere. */
const ICONS = {
  chats: { ios: 'bubble.left.and.bubble.right', android: 'forum', web: 'forum' },
  computer: { ios: 'desktopcomputer', android: 'computer', web: 'computer' },
  phone: { ios: 'iphone', android: 'smartphone', web: 'smartphone' },
  models: { ios: 'cpu', android: 'memory', web: 'memory' },
  add: { ios: 'plus', android: 'add', web: 'add' },
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  stop: { ios: 'stop.fill', android: 'stop', web: 'stop' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  download: { ios: 'arrow.down.circle', android: 'download', web: 'download' },
  trash: { ios: 'trash', android: 'delete', web: 'delete' },
  qr: { ios: 'qrcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' },
  link: { ios: 'link', android: 'link', web: 'link' },
  chevron: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  tool: { ios: 'wrench.and.screwdriver', android: 'build', web: 'build' },
  warning: { ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' },
  lock: { ios: 'lock.fill', android: 'lock', web: 'lock' },
  bolt: { ios: 'bolt.fill', android: 'bolt', web: 'bolt' },
  brain: { ios: 'brain', android: 'psychology', web: 'psychology' },
  folder: { ios: 'folder', android: 'folder', web: 'folder' },
  refresh: { ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' },
  star: { ios: 'star.fill', android: 'star', web: 'star' },
  question: { ios: 'questionmark.bubble', android: 'help', web: 'help' },
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: ColorValue }) {
  return (
    <SymbolView
      name={ICONS[name] as ComponentProps<typeof SymbolView>['name']}
      size={size}
      tintColor={color}
      resizeMode="scaleAspectFit"
      style={{ width: size, height: size }}
    />
  );
}
