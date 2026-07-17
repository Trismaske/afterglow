/**
 * Tiny toast helper (m0.5). Android-first app → ToastAndroid; anywhere
 * else (iOS dev builds) an Alert is the graceless-but-visible fallback.
 */
import { Alert, Platform, ToastAndroid } from 'react-native';

export function showToast(message: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}
