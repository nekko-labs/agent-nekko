/**
 * "Your task is ready" when the app is closed. The computer sends the relay a
 * content-free ping when a run finishes; the relay pushes it to phones that
 * aren't connected, through APNs/FCM, using the native token registered here.
 * Nothing about the chat ever goes through Apple or Google.
 *
 * We only ask for notification permission after a computer is paired, never
 * at first launch.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export interface PushToken {
  token: string;
  platform: 'ios' | 'android';
}

let cached: PushToken | null = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** The native push token if permission is already granted (never prompts). */
export async function currentPushToken(): Promise<PushToken | null> {
  return obtain(false);
}

/** Prompt for permission (once, after pairing) and return the token. */
export async function askForPush(): Promise<PushToken | null> {
  return obtain(true);
}

async function obtain(ask: boolean): Promise<PushToken | null> {
  if (cached) return cached;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('runs', {
        name: 'Finished runs',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const t = await Notifications.getDevicePushTokenAsync();
    if (typeof t.data !== 'string' || !t.data) return null;
    cached = { token: t.data, platform: Platform.OS };
    return cached;
  } catch {
    // No FCM config in this build, simulator without APNs, etc. Push is a nicety.
    return null;
  }
}
