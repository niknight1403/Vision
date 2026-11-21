import React, { useCallback, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import useSWR from "swr";

type ApiRequestInit = { method?: string; headers?: Record<string, string>; body?: string };
type AuthenticatedFetch = (url: string, init?: ApiRequestInit) => Promise<Response>;
type Listing = {
  id: string;
  title: string;
  productUrl: string;
  imageUrl: string | null;
  currency: string;
  priceMinor: string;
  observedAt: string;
  providerId: string;
};

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? "API_REQUEST_FAILED";
  } catch {
    return "API_REQUEST_FAILED";
  }
}

function ListingCard({ listing, onOpen }: { listing: Listing; onOpen: (url: string) => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.listingRow}>
        {listing.imageUrl ? (
          <Image source={{ uri: listing.imageUrl }} accessibilityLabel={`Produktfoto: ${listing.title}`} style={styles.image} />
        ) : <View accessibilityLabel="Kein Produktfoto verfügbar" style={styles.imageFallback} />}
        <View style={styles.listingDetails}>
          <Text style={styles.title}>{listing.title}</Text>
          <Text style={styles.price}>{new Intl.NumberFormat("de-DE", {
            style: "currency", currency: listing.currency,
          }).format(Number(listing.priceMinor) / 100)}</Text>
          <Text style={styles.meta}>eBay · {new Date(listing.observedAt).toLocaleString("de-DE")}</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`eBay-Angebot öffnen: ${listing.title}`}
        onPress={() => onOpen(listing.productUrl)}
        style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
      >
        <Text style={styles.linkText}>Angebot bei eBay öffnen</Text>
      </Pressable>
    </View>
  );
}

export default function EbayListingsSection({
  apiBaseUrl,
  authenticatedFetch,
}: {
  apiBaseUrl: string;
  authenticatedFetch: AuthenticatedFetch;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listingsUrl = `${apiBaseUrl}/v1/listings?limit=50`;
  const {
    data: listings = [],
    error: loadError,
    isLoading,
    mutate,
  } = useSWR<Listing[]>(listingsUrl, async (url: string) => {
    const response = await authenticatedFetch(url);
    if (!response.ok) throw new Error(await responseError(response));
    const body = await response.json() as { listings: Listing[] };
    return body.listings;
  }, { revalidateOnFocus: false });

  const search = useCallback(async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 200) {
      setError("Bitte einen Suchbegriff mit höchstens 200 Zeichen eingeben.");
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${apiBaseUrl}/v1/listings/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: normalizedQuery, limit: 30 }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { listings: Listing[] };
      await mutate(body.listings, false);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "LISTING_SEARCH_FAILED";
      setError(code === "EBAY_API_NOT_CONFIGURED"
        ? "Die eBay Browse API ist noch nicht konfiguriert. Hinterlege EBAY_CLIENT_ID und EBAY_CLIENT_SECRET in den Projektvariablen."
        : code === "EBAY_RATE_LIMITED"
          ? "eBay hat die Suchanfrage begrenzt. Bitte später erneut versuchen."
          : "Die eBay-Suche ist fehlgeschlagen. Bitte Verbindung und API-Konfiguration prüfen.");
    } finally {
      setSearching(false);
    }
  }, [apiBaseUrl, authenticatedFetch, mutate, query]);

  const openListing = useCallback((url: string) => {
    if (!url.startsWith("https://")) return;
    void Linking.openURL(url).catch(() => setError("Das Angebot konnte nicht geöffnet werden."));
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.introCard}>
        <Text style={styles.heading}>Live-Angebote auf eBay</Text>
        <Text style={styles.body}>Durchsuche echte Festpreisangebote und speichere die Ergebnisse sicher in deinem Konto. Die Suche liest nur öffentliche Angebotsdaten.</Text>
        <Text style={styles.safety}>Keine Käufe · keine Gebote · keine Nachrichten · keine Veröffentlichung</Text>
      </View>

      <View style={styles.searchCard}>
        <Text style={styles.label}>Wonach suchst du?</Text>
        <TextInput
          accessibilityLabel="Suchbegriff für eBay-Angebote"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={(event) => {
            const nativeEvent = event.nativeEvent as typeof event.nativeEvent & {
              isComposing?: boolean;
              keyCode?: number;
            };
            if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
            void search();
          }}
          placeholder="z. B. gebrauchte Kamera"
          placeholderTextColor="#7183A3"
          autoCapitalize="sentences"
          maxLength={200}
          returnKeyType="search"
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: searching || !query.trim() }}
          disabled={searching || !query.trim()}
          onPress={() => void search()}
          style={({ pressed }) => [styles.searchButton, (pressed || searching || !query.trim()) && styles.buttonMuted]}
        >
          {searching ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.searchButtonText}>eBay-Angebote suchen</Text>}
        </Pressable>
      </View>

      <View style={styles.resultsHeading}>
        <Text style={styles.sectionTitle}>Gespeicherte Angebote</Text>
        <Pressable accessibilityRole="button" onPress={() => void mutate()}>
          <Text style={styles.refresh}>Aktualisieren</Text>
        </Pressable>
      </View>
      {isLoading ? (
        <View style={styles.statusCard}><ActivityIndicator color="#8DB5FF" /><Text style={styles.body}>Angebote werden geladen …</Text></View>
      ) : listings.length ? (
        listings.map((listing) => <ListingCard key={listing.id} listing={listing} onOpen={openListing} />)
      ) : (
        <View style={styles.statusCard}>
          <Text style={styles.emptyTitle}>Noch keine Angebote gespeichert</Text>
          <Text style={styles.body}>Starte eine eBay-Suche. Nur echte Treffer werden hier angezeigt; es gibt keine Demo- oder Ersatzdaten.</Text>
        </View>
      )}
      {loadError && <Text accessibilityRole="alert" style={styles.error}>Gespeicherte Angebote konnten nicht geladen werden. Bitte erneut anmelden oder die API-Verbindung prüfen.</Text>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  introCard: { backgroundColor: "#101B2C", borderColor: "#345078", borderWidth: 1, borderRadius: 15, padding: 15, gap: 8 },
  heading: { color: "#F3F6FF", fontSize: 20, fontWeight: "900" },
  body: { color: "#B9C6DD", fontSize: 12, lineHeight: 18 },
  safety: { color: "#F3C979", fontSize: 10, lineHeight: 15, fontWeight: "700" },
  searchCard: { backgroundColor: "#121B2C", borderColor: "#293750", borderWidth: 1, borderRadius: 15, padding: 14, gap: 10 },
  label: { color: "#E8EEFC", fontSize: 13, fontWeight: "800" },
  input: { backgroundColor: "#0B1423", borderWidth: 1, borderColor: "#30405B", borderRadius: 9, padding: 12, color: "#F3F6FF", fontSize: 13 },
  searchButton: { backgroundColor: "#315BB0", minHeight: 44, paddingHorizontal: 14, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  buttonMuted: { opacity: 0.55 },
  searchButtonText: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  resultsHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 2 },
  sectionTitle: { color: "#E8EEFC", fontSize: 17, fontWeight: "800" },
  refresh: { color: "#91B7FF", fontSize: 12, fontWeight: "800" },
  statusCard: { backgroundColor: "#121B2C", borderColor: "#293750", borderWidth: 1, borderRadius: 15, padding: 14, gap: 9, alignItems: "flex-start" },
  emptyTitle: { color: "#EDF2FF", fontSize: 14, fontWeight: "800" },
  card: { backgroundColor: "#121B2C", borderColor: "#293750", borderWidth: 1, borderRadius: 15, padding: 12, gap: 10 },
  listingRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  image: { width: 72, height: 72, borderRadius: 9, backgroundColor: "#0B1423" },
  imageFallback: { width: 72, height: 72, borderRadius: 9, backgroundColor: "#0B1423", borderWidth: 1, borderColor: "#293750" },
  listingDetails: { flex: 1, gap: 5 },
  title: { color: "#EDF2FF", fontSize: 13, lineHeight: 18, fontWeight: "800" },
  price: { color: "#A9C5FF", fontSize: 16, fontWeight: "900" },
  meta: { color: "#8394B2", fontSize: 10 },
  linkButton: { alignSelf: "flex-start", paddingVertical: 5 },
  pressed: { opacity: 0.65 },
  linkText: { color: "#91B7FF", fontSize: 12, fontWeight: "800" },
  error: { color: "#FF9B9B", fontSize: 12, lineHeight: 18 },
});
