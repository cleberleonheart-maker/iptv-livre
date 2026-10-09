#!/usr/bin/env bash
# Compila o APK do IPTV Livre sem Gradle (aapt2 + javac + d8 + apksigner).
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/android-sdk}"
BT="$SDK/build-tools/${BT_VERSION:-$(ls "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)}"
AJ="$SDK/platforms/android-34/android.jar"
PROJ="$(cd "$(dirname "$0")" && pwd)"
OUT="$PROJ/../apk"
KS="$PROJ/iptvlivre.keystore"
APK="$OUT/iptv-livre.apk"

[ -f "$AJ" ] || { echo "android.jar nao encontrado: $AJ"; exit 1; }

mkdir -p "$OUT"
rm -rf "$PROJ/build"
mkdir -p "$PROJ/build"/{res,classes,dex,gen}

echo "==> aapt2 compile (resources)"
"$BT/aapt2" compile --dir "$PROJ/res" -o "$PROJ/build/res/resources.zip"

echo "==> aapt2 link (manifest + resources)"
"$BT/aapt2" link \
  -o "$PROJ/build/base.apk" \
  -I "$AJ" \
  --manifest "$PROJ/AndroidManifest.xml" \
  -R "$PROJ/build/res/resources.zip" \
  --java "$PROJ/build/gen" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0.0 \
  --auto-add-overlay

echo "==> javac (java + R.java)"
find "$PROJ/java" "$PROJ/build/gen" -name '*.java' > "$PROJ/build/sources.txt"
javac -nowarn -encoding UTF-8 \
  -source 8 -target 8 \
  -bootclasspath "$AJ" \
  -classpath "$AJ" \
  -d "$PROJ/build/classes" \
  @"$PROJ/build/sources.txt" 2>&1 \
  | grep -v 'bootstrap class path\|source value 8\|target value 8\|deprecat' || true

[ -f "$PROJ/build/classes/br/com/iptvlivre/MainActivity.class" ] \
  || { echo "ERRO: MainActivity nao compilou"; exit 1; }

echo "==> d8 (classes.dex)"
find "$PROJ/build/classes" -name '*.class' > "$PROJ/build/classes.txt"
"$BT/d8" --lib "$AJ" --min-api 21 --release \
  --output "$PROJ/build/dex" @"$PROJ/build/classes.txt"

echo "==> empacotando dex no apk"
cp "$PROJ/build/base.apk" "$PROJ/build/unsigned.apk"
( cd "$PROJ/build/dex" && zip -q -X "$PROJ/build/unsigned.apk" classes.dex )

echo "==> zipalign"
"$BT/zipalign" -f -p 4 "$PROJ/build/unsigned.apk" "$PROJ/build/aligned.apk"

if [ ! -f "$KS" ]; then
  echo "==> gerando keystore"
  keytool -genkeypair -v -keystore "$KS" -storepass iptvlivre123 \
    -keypass iptvlivre123 -alias iptvlivre -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=IPTV Livre, OU=App, O=IPTV, L=Brasil, S=SP, C=BR" >/dev/null 2>&1
fi

echo "==> apksigner"
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:iptvlivre123 --key-pass pass:iptvlivre123 \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$APK" "$PROJ/build/aligned.apk"

echo "==> verificando"
"$BT/apksigner" verify "$APK" && echo "assinatura ok"
"$BT/aapt2" dump badging "$APK" | head -5
ls -la "$APK"
echo "OK -> $APK"