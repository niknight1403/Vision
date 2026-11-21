import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { runDemoAutopilot, type DemoAutopilotRun } from "@autonomagent/trading-core";

const currency = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const formatCents = (cents: bigint) => currency.format(Number(cents) / 100);
const formatRoi = (basisPoints: bigint | null) =>
  basisPoints === null ? "Nicht berechenbar" : `${(Number(basisPoints) / 100).toFixed(1)} %`;

function Panel({ children }: { children: React.ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}

function DemoRunSummary({ run }: { run: DemoAutopilotRun }) {
  return (
    <>
      <Panel>
        <Text style={styles.panelTitle}>Lokaler Lauf abgeschlossen</Text>
        <Text style={styles.bodyText}>
          {run.assessments.length} Beispielprodukte bewertet · {run.listingDrafts.length} unveröffentlichte Entwürfe · {run.approvalQueue.length} manuelle Prüfungen
        </Text>
        <Text style={styles.safetyText}>
          {run.externalCalls} externe Aufrufe · keine Käufe · keine Veröffentlichung · keine Speicherung
        </Text>
      </Panel>

      <Text style={styles.sectionTitle}>Produktbewertung</Text>
      {run.assessments.map((assessment) => (
        <Panel key={assessment.product.id}>
          <View style={styles.rowBetween}>
            <Text style={styles.itemTitle}>{assessment.product.title}</Text>
            <Text style={assessment.riskReasons.length ? styles.warning : styles.pass}>
              {assessment.riskReasons.length ? "Prüfung nötig" : "Für manuelle Prüfung geeignet"}
            </Text>
          </View>
          <Text style={styles.muted}>{assessment.product.category} · DEMO-DATENSATZ</Text>
          <Text style={styles.bodyText}>Beispiel-Verkaufspreis: {formatCents(assessment.product.resalePriceCents)}</Text>
          <Text style={styles.bodyText}>Beispiel-Gesamtkosten: {formatCents(assessment.totalCostCents)}</Text>
          <Text style={styles.metric}>Beispiel-Netto: {formatCents(assessment.netProfitCents)}</Text>
          <Text style={styles.bodyText}>Rechnerischer ROI: {formatRoi(assessment.roiBasisPoints)}</Text>
          {assessment.riskReasons.map((reason) => (
            <Text key={reason} style={styles.warning}>{reason}</Text>
          ))}
        </Panel>
      ))}

      <Text style={styles.sectionTitle}>Listing-Entwürfe</Text>
      {run.listingDrafts.map((draft) => (
        <Panel key={draft.id}>
          <View style={styles.rowBetween}>
            <Text style={styles.itemTitle}>{draft.title}</Text>
            <Text style={styles.muted}>{draft.channelLabel}</Text>
          </View>
          <Text style={styles.bodyText}>{draft.description}</Text>
          <Text style={styles.safetyText}>Entwurf · unveröffentlicht · Freigabe erforderlich</Text>
        </Panel>
      ))}

      <Text style={styles.sectionTitle}>Kanalideen</Text>
      {run.reachRecommendations.map((recommendation) => (
        <Panel key={`${recommendation.productId}-${recommendation.channel}`}>
          <Text style={styles.itemTitle}>{recommendation.channelLabel}</Text>
          <Text style={styles.bodyText}>{recommendation.rationale}</Text>
          <Text style={styles.muted}>
            Nur Szenario: {recommendation.illustrativeWeeklyViews.min}–{recommendation.illustrativeWeeklyViews.max} mögliche Aufrufe pro Woche; nicht gemessen und keine Prognose.
          </Text>
        </Panel>
      ))}
    </>
  );
}

export default function DemoAutopilotScreen() {
  const [run, setRun] = useState<DemoAutopilotRun | null>(null);

  return (
    <View style={styles.container}>
      <View style={styles.introPanel}>
        <Text style={styles.heading}>Lokaler Produktpilot</Text>
        <Text style={styles.bodyText}>
          Starte eine deterministische Beispielanalyse. Die Berechnungen laufen auf dem Gerät mit fest eingebauten Demo-Produkten; es werden keine Anbieter kontaktiert.
        </Text>
        <Text style={styles.safetyText}>PAPER-MODUS · BEISPIELWERTE · KEINE FINANZ- ODER KAUFEMPFEHLUNG</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Lokalen Demo-Lauf starten"
        onPress={() => setRun(runDemoAutopilot())}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>{run ? "Demo erneut ausführen" : "Demo starten"}</Text>
      </Pressable>

      {run ? (
        <DemoRunSummary run={run} />
      ) : (
        <Panel>
          <Text style={styles.panelTitle}>Bereit für den Demo-Lauf</Text>
          <Text style={styles.bodyText}>
            Es werden Kosten, illustrative Erlöse und Risikoregeln berechnet. Geeignete Beispiele erhalten unveröffentlichte Listing-Entwürfe und rein illustrative Kanalideen.
          </Text>
        </Panel>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  introPanel: { backgroundColor: "#101B2C", borderColor: "#345078", borderWidth: 1, borderRadius: 15, padding: 16, gap: 10 },
  heading: { color: "#F3F6FF", fontSize: 20, fontWeight: "900" },
  sectionTitle: { color: "#E8EEFC", fontSize: 17, fontWeight: "800", marginTop: 6 },
  panel: { backgroundColor: "#121B2C", borderColor: "#293750", borderWidth: 1, borderRadius: 15, padding: 14, gap: 9 },
  panelTitle: { color: "#F4F7FF", fontSize: 15, fontWeight: "800" },
  itemTitle: { color: "#EDF2FF", fontSize: 14, fontWeight: "800", flex: 1 },
  bodyText: { color: "#B9C6DD", fontSize: 12, lineHeight: 18 },
  muted: { color: "#8394B2", fontSize: 10, lineHeight: 15 },
  safetyText: { color: "#F3C979", fontSize: 10, lineHeight: 15, fontWeight: "700" },
  metric: { color: "#A9C5FF", fontSize: 16, lineHeight: 22, fontWeight: "900" },
  pass: { color: "#8BD8B0", fontSize: 10, fontWeight: "800", textAlign: "right" },
  warning: { color: "#F0C178", fontSize: 10, lineHeight: 15 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  button: { backgroundColor: "#315BB0", padding: 14, borderRadius: 10, alignItems: "center" },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: "#FFF", fontWeight: "800", fontSize: 13 },
});
