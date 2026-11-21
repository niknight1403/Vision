import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const REFRESH_TOKEN_KEY = "autonomagent.refresh-token";

export async function readStoredRefreshToken(): Promise<string | null> {
  if (Platform.OS === "web") return null;
  return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function storeRefreshToken(token: string): Promise<void> {
  if (Platform.OS === "web") return;
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearStoredRefreshToken(): Promise<void> {
  if (Platform.OS === "web") return;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
