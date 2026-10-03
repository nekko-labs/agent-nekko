import Svg, { G, Path } from 'react-native-svg';

import { usePalette } from './theme';

/**
 * Nekko's head, the same outline art as the desktop app icon
 * (apps/desktop/build/icon.svg): stick-cat outline, slim sunglasses, earpiece.
 * Drawn in the theme's ink so it sits on light and dark backgrounds alike.
 */
export function Mascot({ size = 72 }: { size?: number }) {
  const p = usePalette();
  return (
    <Svg width={size} height={size} viewBox="4 0 20 24" accessibilityLabel="Nekko">
      <G fill="none">
        <Path
          d="M 5.5 10 C 5.8 6.1 7.1 3.4 7.4 2.2 Q 7.7 0.7 8.9 1.7 L 12.9 5.1 L 17.1 1.7 Q 18.3 0.7 18.6 2.2 C 18.9 3.4 20.2 6.1 20.5 10 L 20.5 17.4 C 20.5 21.2 17.2 23.2 13 23.2 C 8.8 23.2 5.5 21.2 5.5 17.4 Z"
          fill={p.paper}
          stroke={p.ink}
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
        <Path d="M 7.9 6 L 8 3.1 L 10.5 5.2 M 15.5 5.2 L 18 3.1 L 18.1 6" stroke="#f0a35e" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
        <G fill={p.ink} stroke={p.ink} strokeWidth={0.8} strokeLinejoin="round" strokeLinecap="round">
          <Path d="M 8.3 12.4 L 12.1 12.7 L 11.7 15 Q 9.9 15.6 8.7 14.5 Z M 14 12.7 L 17.8 12.4 L 17.4 14.5 Q 16.2 15.6 14.4 15 Z" />
          <Path d="M 12 13.2 Q 13 12.6 14.1 13.2 M 8.3 12.6 L 7 12 M 17.8 12.6 L 19.1 12" fill="none" />
        </G>
        <Path d="M 20.5 12.9 Q 22.6 12.9 22.6 14.5 Q 22.6 16.1 20.5 16.1" fill={p.paper} stroke={p.ink} strokeWidth={1} strokeLinecap="round" />
        <Path d="M 11.8 17.3 q 1.2 1.1 2.4 0" stroke={p.ink} strokeWidth={0.9} strokeLinecap="round" />
      </G>
    </Svg>
  );
}
