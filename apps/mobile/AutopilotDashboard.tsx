import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  ApiClient, ApiError, isPollableTaskStatus, pollTaskStatus,
  type Deal, type PollSnapshot, type PollingState, type TreasureAnalysisTask,
} from "./src/api";

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

const roleLabels: Record<string, string> = {
  visual_identification: "Bild- & Modell-Erkennung",
  market_research: "Markt- & Verkaufspreise",
  collector_rarity: "Sammlerwert & Seltenheit",
  technical_parts: "Technik & Ersatzteile",
  restoration: "Zustand & Restaurierung",
  risk_authenticity: "Risiko & Echtheitsindikatoren",
};
const money = (minor: number | null, currency = "EUR") =>
  minor === null ? "Keine belastbare Bewertung" :
    new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(minor / 100);

/** Maps a typed client error to a short, non-technical UI message. */
function errorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "UNBEKANNTER_FEHLER · Bitte erneut versuchen.";
  switch (cause.kind) {
    case "network":
      return "NETZFEHLER · Keine Verbindung zur API. Der letzte Stand bleibt sichtbar.";
    case "timeout":
      return "ZEITUEBERSCHREITUNG · Die API hat nicht rechtzeitig geantwortet.";
    case "aborted":
      return "ABGEBROCHEN · Die Anfrage wurde beendet.";
    case "session_expired":
      return "SITZUNG ABGELAUFEN · Bitte erneut anmelden.";
    case "rate_limited":
      return cause.retryAfterMs
        ? `RATE-LIMIT · Zu viele Anfragen. Erneut in ${Math.ceil(cause.retryAfterMs / 1000)} s.`
        : "RATE-LIMIT · Zu viele Anfragen. Bitte kurz warten.";
    case "server":
      return `SERVERFEHLER${cause.status ? ` ${cause.status}` : ""} · Bitte erneut versuchen.`;
    case "invalid_json":
      return "UNGUELTIGE_ANTWORT · Die API-Antwort war nicht lesbar.";
    default:
      return cause.code ? `${cause.message} · ${cause.code}` : cause.message;
  }
}

const pollNote = (state: PollingState | undefined): string | null => {
  if (state === "offline") {
    return "OFFLINE · Keine Verbindung. Der letzte Stand bleibt sichtbar, die App fragt mit wachsendem Abstand erneut.";
  }
  if (state === "error") {
    return "POLLING_FEHLER · Die Statusabfrage ist endgueltig fehlgeschlagen. Erneut pruefen startet einen neuen Versuch.";
  }
  if (state === "expired") return "SITZUNG ABGELAUFEN · Bitte erneut anmelden.";
  return null;
};

function Panel({ children }: { children: React.ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}
function ActionButton({ title, onPress, disabled = false }: {
  title: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, (pressed || disabled) && styles.buttonMuted]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}
function TaskResult({ task, pollState, onRetry }: {
  task: TreasureAnalysisTask; pollState?: PollingState; onRetry: () => void;
}) {
  const assessment = task.result?.assessment;
  const visual = task.result?.visual_inspection;
  const isPolling = task.status === "QUEUED" || task.status === "RUNNING" || task.status === "CHECKPOINTED";
  const note = pollNote(pollState);
  return (
    <Panel>
      <View style={styles.rowBetween}>
        <Text style={styles.panelTitle}>Agenten-Ergebnis</Text>
        <Text style={styles.status}>{isPolling ? `POLLING · ${task.status}` : task.status}</Text>
      </View>
      {visual && (
        <View style={styles.subPanel}>
          <Text style={styles.itemTitle}>Visuelle Identifikation</Text>
          <Text style={styles.bodyText}>Modell: {visual.exact_model ?? "Unbekannt"}</Text>
          <Text style={styles.bodyText}>Zustand: {visual.condition_grade ?? "Unklar"}</Text>
          {!!visual.details && <Text style={styles.muted}>{visual.details}</Text>}
        </View>
      )}
      {assessment ? (
        <>
          <View style={styles.scoreRow}>
            <View><Text style={styles.metric}>{assessment.score}/100</Text><Text style={styles.muted}>Fund-Score</Text></View>
            <View><Text style={styles.metric}>{Math.round(assessment.confidence * 100)}%</Text><Text style={styles.muted}>Konfidenz</Text></View>
            <View><Text style={styles.metric}>{assessment.comparable_count}</Text><Text style={styles.muted}>Verkaufspreise</Text></View>
          </View>
          <Text style={styles.itemTitle}>Bewertung · {assessment.valuation_status}</Text>
          <Text style={styles.bodyText}>Geschätzter Wiederverkauf: {money(assessment.resale_value_low_minor, assessment.currency)} – {money(assessment.resale_value_high_minor, assessment.currency)}</Text>
          <Text style={styles.bodyText}>Netto-Spanne vor weiteren unbekannten Kosten: {money(assessment.estimated_net_low_minor, assessment.currency)} – {money(assessment.estimated_net_high_minor, assessment.currency)}</Text>
          {assessment.findings.map((finding) => (
            <View key={finding.role} style={styles.finding}>
              <View style={styles.rowBetween}>
                <Text style={styles.findingTitle}>{roleLabels[finding.role] ?? finding.role}</Text>
                <Text style={styles.status}>{finding.status}</Text>
              </View>
              <Text style={styles.bodyText}>{finding.summary}</Text>
              <Text style={styles.muted}>Konfidenz: {Math.round(finding.confidence * 100)}%</Text>
            </View>
          ))}
          {assessment.conflicts.map((item, index) => <Text key={index} style={styles.warning}>• {item}</Text>)}
          {assessment.next_actions.map((item, index) => <Text key={index} style={styles.muted}>Nächster Schritt: {item}</Text>)}
        </>
      ) : isPolling ? (
        <View style={styles.progress}><ActivityIndicator color="#8DB5FF" /><Text style={styles.bodyText}>Spezialisten analysieren den Fund. Ergebnis wird automatisch aktualisiert.</Text></View>
      ) : task.status === "FAILED" ? <Text style={styles.error}>FAILED · Die Analyse ist fehlgeschlagen. Keine automatische fachliche Wiederholung wurde ausgelöst.</Text>
        : <Text style={styles.warning}>Noch kein Analyseergebnis vorhanden. Status und Fehlerprotokoll im Backend prüfen.</Text>}
      {note && <Text style={styles.warning}>{note}</Text>}
      {note && pollState !== "expired" && (
        <Pressable accessibilityRole="button" onPress={onRetry}><Text style={styles.link}>Status erneut prüfen</Text></Pressable>
      )}
      <Text style={styles.safetyNote}>Keine Echtheitsgarantie · keine Kauf-Freigabe · keine Verkäuferkontaktaufnahme.</Text>
    </Panel>
  );
}

export default function AutopilotDashboard() {
  const client = useMemo(
    () => (API_BASE_URL ? new ApiClient({ baseUrl: API_BASE_URL }) : null),
    [],
  );
  const pollersRef = useRef<Map<string, { stop: () => void }>>(new Map());
  const finishedRef = useRef<Set<string>>(new Set());

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"checking" | "reachable" | "unavailable">("checking");
  useEffect(() => {
    if (!client || !signedIn) return;
    const controller = new AbortController();
    let running = false;
    const check = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        await client.getOperationsOverview({ signal: controller.signal });
        if (!controller.signal.aborted) setBackendStatus("reachable");
      } catch {
        if (!controller.signal.aborted) setBackendStatus("unavailable");
      } finally { running = false; }
    };
    setBackendStatus("checking");
    void check();
    const timer = setInterval(() => void check(), 30000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [client, signedIn]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, TreasureAnalysisTask>>({});
  const [pollStates, setPollStates] = useState<Record<string, PollingState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopAllPollers = useCallback(() => {
    for (const poller of pollersRef.current.values()) poller.stop();
    pollersRef.current.clear();
  }, []);

  const resetToSignedOut = useCallback((message: string | null) => {
    stopAllPollers();
    finishedRef.current.clear();
    client?.session.clear();
    setSignedIn(false);
    setDeals([]);
    setImageUrls({});
    setTasks({});
    setPollStates({});
    setPassword("");
    setError(message);
  }, [client, stopAllPollers]);

  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.kind === "session_expired") {
      resetToSignedOut("SITZUNG ABGELAUFEN · Bitte erneut anmelden.");
      return;
    }
    setError(errorText(cause));
  }, [resetToSignedOut]);

  const signIn = useCallback(async () => {
    if (!client) {
      setError("EXPO_PUBLIC_API_URL ist nicht gesetzt. Bitte die API-URL in der App-Build-Umgebung konfigurieren.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await client.login(email, password);
      setPassword("");
      setSignedIn(true);
      setDeals(await client.listDeals({ limit: 50 }));
    } catch (cause) {
      client.session.clear();
      setSignedIn(false);
      setError(errorText(cause));
    } finally { setBusy(false); }
  }, [client, email, password]);

  const loadDeals = useCallback(async () => {
    if (!client) return;
    try {
      setDeals(await client.listDeals({ limit: 50 }));
      setError(null);
    } catch (cause) { handleError(cause); }
  }, [client, handleError]);

  const signOut = useCallback(() => {
    void client?.logout();
    resetToSignedOut(null);
  }, [client, resetToSignedOut]);

  const startAnalysis = useCallback(async (deal: Deal) => {
    if (!client) return;
    const imageUrl = (imageUrls[deal.id] ?? "").trim();
    if (!/^https:\/\//i.test(imageUrl)) {
      setError("Bitte eine HTTPS-Bildadresse eintragen. Die Bilddomain muss serverseitig freigegeben sein.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const task = await client.startTreasureAnalysis(deal.id, imageUrl);
      setTasks((current) => ({ ...current, [deal.id]: { taskId: task.taskId, status: task.status } }));
      setPollStates((current) => ({ ...current, [deal.id]: "loading" }));
    } catch (cause) {
      handleError(cause);
    } finally { setBusy(false); }
  }, [client, imageUrls, handleError]);

  const retryPolling = useCallback((dealId: string) => {
    const task = tasks[dealId];
    if (!task) return;
    finishedRef.current.delete(task.taskId);
    setError(null);
    // A fresh object identity re-runs the polling effect below.
    setTasks((current) => ({ ...current, [dealId]: { ...task } }));
  }, [tasks]);

  // One poller per task id. The layer owns backoff, 429 and session expiry.
  useEffect(() => {
    if (!client || !signedIn) return;
    for (const [dealId, task] of Object.entries(tasks)) {
      if (!isPollableTaskStatus(task.status)) continue;
      if (finishedRef.current.has(task.taskId)) continue;
      if (pollersRef.current.has(task.taskId)) continue;

      const handle = pollTaskStatus({
        client,
        taskId: task.taskId,
        onSnapshot: (snapshot: PollSnapshot) => {
          if (!pollersRef.current.has(task.taskId)) return;
          setPollStates((current) => ({ ...current, [dealId]: snapshot.state }));
          const next = snapshot.task;
          if (next) {
            setTasks((current) => (
              current[dealId]?.taskId === next.taskId ? { ...current, [dealId]: next } : current
            ));
          }
        },
      });
      pollersRef.current.set(task.taskId, handle);
      void handle.promise.then((final) => {
        if (pollersRef.current.get(task.taskId) !== handle) return;
        pollersRef.current.delete(task.taskId);
        finishedRef.current.add(task.taskId);
        setPollStates((current) => ({ ...current, [dealId]: final.state }));
        if (final.state === "expired") {
          resetToSignedOut("SITZUNG ABGELAUFEN · Bitte erneut anmelden.");
        } else if (final.state === "error" && final.error) {
          setError(errorText(final.error));
        }
      });
    }
  }, [client, signedIn, tasks, resetToSignedOut]);

  useEffect(() => () => stopAllPollers(), [stopAllPollers]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.commandBar}><Text style={styles.eyebrow}>VISION / ORBIT</Text><Text style={[styles.commandStatus, (!signedIn || backendStatus !== "reachable") && styles.warning]}>{signedIn ? (backendStatus === "reachable" ? "● API ERREICHBAR" : backendStatus === "checking" ? "○ API-PRÜFUNG" : "○ STATUS NICHT VERFÜGBAR") : client ? "○ NICHT VERBUNDEN" : "○ API NICHT KONFIGURIERT"}</Text></View>
        <View style={styles.hero}><Text style={styles.heroBadge}>VISION SWARM · 6 SPEZIALISTEN</Text><Text style={styles.heading}>Finde das\nBesondere.</Text><Text style={styles.intro}>Dein Agententeam prüft Modellhinweise, Sammlerwert, Ersatzteile, Restaurierung und Risiken.</Text></View>
        <View style={styles.safetyBanner}>
          <Text style={styles.safetyTitle}>◈ DATENSTATUS · PROVIDER</Text>
          <Text style={styles.muted}>Produktdaten und Analysen werden serverseitig über konfigurierte Provider verarbeitet.</Text>
        </View>

        {!signedIn ? (
          <Panel>
            <Text style={styles.panelTitle}>Kontrollzentrum öffnen</Text><Text style={styles.bodyText}>Melde dich an, um Produktkandidaten und laufende Analysen zu sehen.</Text>
            <TextInput value={email} onChangeText={setEmail} accessibilityLabel="E-Mail" placeholder="E-Mail" placeholderTextColor="#7183A3" autoCapitalize="none" keyboardType="email-address" style={styles.input} />
            <TextInput value={password} onChangeText={setPassword} accessibilityLabel="Passwort" placeholder="Passwort" placeholderTextColor="#7183A3" secureTextEntry style={styles.input} />
            <ActionButton title={busy ? "Anmeldung läuft …" : "Sicher anmelden"} onPress={() => void signIn()} disabled={busy} />
            <Text style={styles.muted}>Zugangsdaten werden nur für den Login übertragen und nicht lokal gespeichert.</Text>
          </Panel>
        ) : (
          <>
            <View style={styles.overview}><View><Text style={styles.label}>PRODUKTKANDIDATEN</Text><Text style={styles.overviewValue}>{deals.length}</Text></View><View><Text style={styles.label}>ANALYSEN</Text><Text style={styles.overviewValue}>{Object.keys(tasks).length}</Text></View><View><Text style={styles.label}>AKTIV</Text><Text style={styles.overviewValue}>{Object.values(tasks).filter((task) => isPollableTaskStatus(task.status)).length}</Text></View></View>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Produktkandidaten</Text>
              <Pressable onPress={() => void loadDeals()}><Text style={styles.link}>Aktualisieren</Text></Pressable>
            </View>
            {deals.length === 0 ? <Panel><Text style={styles.bodyText}>Keine Produktkandidaten gefunden. Zuerst Produkte über eine angeschlossene Datenquelle erfassen.</Text></Panel> :
              deals.map((deal) => (
                <Panel key={deal.id}>
                  <View style={styles.rowBetween}><Text style={[styles.itemTitle, styles.dealTitle]}>{deal.title}</Text><Text style={styles.dealBadge}>{deal.simulated ? "DEMO" : "PROVIDER"}</Text></View>
                  <Text style={styles.muted}>{deal.reviewStatus} · {deal.currency}</Text>
                  <Text style={styles.bodyText}>Angebotspreis: {money(Number(deal.purchasePriceMinor), deal.currency)}</Text>
                  <Text style={styles.bodyText}>Gesamtkosten: {money(Number(deal.totalCostCents), deal.currency)}</Text>
                  <Text style={styles.muted}>{deal.riskPassed ? "Regelprüfung bestanden" : "Risiko-Prüfung offen"} · {deal.riskReasons.join(", ")}</Text>
                  <TextInput value={imageUrls[deal.id] ?? ""} onChangeText={(value) => setImageUrls((current) => ({ ...current, [deal.id]: value }))}
                    accessibilityLabel="HTTPS-Bildadresse des Produkts" placeholder="HTTPS-Bildadresse des Produkts" placeholderTextColor="#7183A3" autoCapitalize="none" style={styles.input} />
                  <ActionButton title={busy ? "Bitte warten …" : "6 Spezialisten analysieren lassen"}
                    onPress={() => void startAnalysis(deal)} disabled={busy || !deal.id || (tasks[deal.id] ? isPollableTaskStatus(tasks[deal.id]!.status) : false)} />
                  {tasks[deal.id] && (
                    <TaskResult
                      task={tasks[deal.id]!}
                      pollState={pollStates[deal.id]}
                      onRetry={() => retryPolling(deal.id)}
                    />
                  )}
                </Panel>
              ))
            }
            <ActionButton title="Abmelden" onPress={signOut} />
          </>
        )}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Text style={styles.footer}>Verkaufspreise werden nur bei ausreichend aktuellen, belegten Vergleichsverkäufen ausgewiesen. Ohne echte Marktdaten bleibt die Bewertung offen. Keine Echtheitszertifizierung oder Kaufempfehlung.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  commandBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  commandStatus: { color: "#55DEC9", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  hero: { backgroundColor: "#10233A", borderColor: "#254462", borderWidth: 1, borderRadius: 24, padding: 23, gap: 11, overflow: "hidden" },
  heroBadge: { alignSelf: "flex-start", color: "#63E2D1", backgroundColor: "#1A3F52", borderRadius: 18, overflow: "hidden", paddingHorizontal: 10, paddingVertical: 7, fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  overview: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#14243B", borderWidth: 1, borderColor: "#294263", borderRadius: 18, padding: 16 },
  label: { color: "#8DA6C7", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  overviewValue: { color: "#E9F7FF", fontSize: 26, fontWeight: "900", marginTop: 5 },
  dealBadge: { color: "#65DDCE", backgroundColor: "#1C3E52", borderRadius: 12, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 5, fontSize: 9, fontWeight: "800" },
  dealTitle: { flex: 1 },
  safe: { flex: 1, backgroundColor: "#080F20" },
  container: { padding: 18, gap: 15, paddingBottom: 42 },
  eyebrow: { color: "#91B9D8", fontSize: 10, letterSpacing: 2, fontWeight: "800" },
  heading: { color: "#F3F6FF", fontSize: 32, lineHeight: 35, fontWeight: "900" },
  intro: { color: "#AAB8D1", fontSize: 13, lineHeight: 20 },
  safetyBanner: { backgroundColor: "#142535", borderColor: "#31536A", borderWidth: 1, borderRadius: 12, padding: 13, gap: 5 },
  safetyTitle: { color: "#6DDFD1", fontSize: 12, fontWeight: "900" },
  section: { color: "#E8EEFC", fontSize: 18, fontWeight: "800" },
  panel: { backgroundColor: "#14243B", borderColor: "#294263", borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  subPanel: { backgroundColor: "#0B1B2D", borderRadius: 10, padding: 10, gap: 4 },
  panelTitle: { color: "#F4F7FF", fontSize: 15, fontWeight: "800" },
  itemTitle: { color: "#EDF2FF", fontSize: 15, fontWeight: "800" },
  bodyText: { color: "#B9C6DD", fontSize: 12, lineHeight: 18 },
  muted: { color: "#8394B2", fontSize: 10, lineHeight: 15 },
  input: { backgroundColor: "#0B1B2D", borderWidth: 1, borderColor: "#37536F", borderRadius: 9, padding: 12, color: "#F3F6FF", fontSize: 13 },
  button: { backgroundColor: "#41D7C7", padding: 13, borderRadius: 10, alignItems: "center" },
  buttonMuted: { opacity: 0.55 },
  buttonText: { color: "#082334", fontWeight: "900", fontSize: 13 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  link: { color: "#91B7FF", fontSize: 12, fontWeight: "800" },
  status: { color: "#77DDCF", fontSize: 10, fontWeight: "800" },
  scoreRow: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 8 },
  metric: { color: "#81E8D8", fontSize: 20, fontWeight: "900" },
  finding: { borderTopWidth: 1, borderTopColor: "#31506A", paddingTop: 8, gap: 4 },
  findingTitle: { color: "#E5ECFB", fontSize: 12, fontWeight: "800", flex: 1 },
  warning: { color: "#F0C178", fontSize: 11, lineHeight: 16 },
  progress: { flexDirection: "row", alignItems: "center", gap: 10 },
  safetyNote: { color: "#E2B96E", fontSize: 10, lineHeight: 15 },
  error: { color: "#FF9E9E", backgroundColor: "#351C23", borderRadius: 9, padding: 10, fontSize: 12 },
  footer: { color: "#6E7E99", fontSize: 10, lineHeight: 16, textAlign: "center", marginTop: 14 },
});
