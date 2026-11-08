# FantaSuite Multi-Fanta Ultimate · FUSION ENGINE 30.0

Pubblicazione su GitHub Pages: carica il contenuto dello zip nella radice del repository (`index.html` è già autonomo: motore e dati sono incorporati), poi Settings → Pages → Deploy from a branch → main / root.

## Origine dei dati e scelte di fusione
- **Giocatori**: 502, ID master non rinumerati (0–563, con buchi). Base = Index333 (7 nov, G11); i valori del master del 27 ott (G9) sono in `previous` e alimentano la differenza rispetto all'aggiornamento precedente.
- **Voto atteso / fantavoto atteso di fonte** (storico v16.3, regressione prudenziale) = ancora del modello. Da MAX-21.0 restano: modello a componenti, floor/ceiling, valorizzazione allenatore.
- **Eliminato da MAX-21.0**: punteggio moltiplicativo (presenza × titolarità × minuti = tripla penalità), `weights` e `match` mai usati, fattore tattico basato su regex (codice morto: leggeva `.note` su numeri), +0,10 fisso ai difensori.
- **Allenatori**: Index333 indicava Tedesco (Bologna) e Grosso (Fiorentina); corretti in Palladino e Vanoli (PDF fantacalcio.it e master). Moduli e rigoristi dal PDF.
- **Non fuso**: motore Python/FantaLab (200 giocatori con ID FotMob non collegabili agli ID master) e i 11 runtime JS storici (elencati in `legacy_runtimes`, non riportati: molte funzioni di UI/scambi, 4 nomi duplicati).
- **11 coppie nome+club con ID diversi** (es. Odgaard 204/546): conservate, da verificare.

## Formule
- `ExpectedMinutesUncond = ap × minuti|presenza` (se i minuti coincidono con 90×ap sono trattati come non condizionati e riconvertiti).
- `EFV = voto base + 3·xG90·m/90 + 1·xA90·m/90 + altri netti (= fantavoto fonte − voto − gol − assist) + valorizzazione + casa/trasferta + forma`. La somma dei contributi è verificata (tolleranza 1e-3).
- `Utilità = vp·EFV + (1−vp)·5,5`. Presenza/titolarità/minuti non moltiplicano più volte: vp (≤ presenza) solo qui, minuti solo sulle frequenze di gol/assist, titolarità solo come flag di rischio.
- `sd = sd_ruolo·(1+0,5·(1−confidenza))`; floor = EFV − 1,28·sd; ceiling = EFV + 1,28·√(sd²+varianza bonus). Confidenza = data quality × (1 − 0,05·campi mancanti): cambia solo l'ampiezza, mai il valore atteso.
- Strategia: `indice = U + a·(ceiling−U) − b·(U−floor)`; prudente (0; 0,5), bilanciata (0,15; 0,15), aggressiva (0,5; 0).
- Modificatore difesa: campionamento deterministico (200 estrazioni, seed 30) sui voti puri di portiere + difensori, con riserve; soglie configurabili (default 6/6,25/6,5/6,75/7 → +1…+5: **verifica la regola della tua lega**). Il modulo è scelto sul totale = Σ indici + modificatore atteso.
- Panchina: portiere di riserva, poi greedy sul valore marginale di copertura (vp × (EFV − 5,5) × probabilità di bisogno del ruolo); rischio “meno di 11” via distribuzione di Poisson-binomiale.
- Sorprese: percentili di upside, utilità, bassa FVM, vp; esclusi indisponibili, vp < 0,6, confidenza < 0,5 e top 10% di utilità del ruolo.
Tutti i coefficienti sono in `COEF` (`fantasuite-fusion-engine-30.js`) e nel JSON dati.

## Interfaccia e dettaglio giocatore
Ogni riga di listone, migliori, sorprese e formazione è cliccabile: il dettaglio mostra la scomposizione dell'indice di schierabilità (componenti × prob. di voto + sostituto + adeguamento strategia = indice) e del fantavoto atteso. Il listone si ordina per **fattore sorpresa** = fantavoto atteso − fantamedia abituale (n/d se manca la fantamedia, 17 giocatori), per surprise score del motore, indice, fantavoto, floor, ceiling, prob. di voto o nome.

## Uso
Fantacalci → crea; Rose → squadre, ricerca per nome/ID, import CSV (ID o `nome,club`), export; Formazione → strategia e calcolo; Aggiornamenti → import JSON (`players[]` con `id`, `role`, `name`), backup/ripristino. Stato in localStorage (`fs-fusion30-v1`, schema 1).

## Test
`node fantasuite-fusion-engine-30.test.js` → 32 test superati (502 ID, assenza NaN, indisponibili, no doppia penalità, qualità dato, contributi, aggiornamenti, multi-fanta, ottimizzatore, 3 vs 4 difensori, panchina, sorprese).

## Limiti noti
Matchup, xG per ruolo tattico, clean sheet, cartellini, forma a 5 partite, impegni europei e turnover non hanno dati strutturati: restano `null`/neutri e segnalati. Non implementati: Mantra (solo predisposto in `mode`), IndexedDB (usa localStorage), Web Worker, confronto grafico a colonne dedicato, sezioni Dashboard/Fonti/Squadre separate, ricalcolo automatico da fonti remote. Rigoristi non abbinati per omonimia (Martinez, Locatelli, Geubbels, Touré, Busio) o assenza (Pessina). UI non verificata in un browser grafico.
