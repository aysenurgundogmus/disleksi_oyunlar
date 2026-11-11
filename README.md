# Disleksi Oyunları (Frontend + Backend)

Bu proje, statik mini oyunları Python veya Node backend ile çalıştırır.

## Çalıştırma (Python backend ile)

```bash
python3 app.py
```

Tarayıcı linki: `http://127.0.0.1:5500/`

Oyun menüsü beş oyundan oluşur. Cümle Tamamlama'nın soru havuzu
`hikaye-tamamlama/questions.json` dosyasındadır; her doğru/yanlış seçim tur
skoruna ve telemetri denemesine eklenir. Cümle Tamamlama, Kafiye, Harf
Karıştırma ve Ses Avı 10 denemede sonuç penceresini açar; Hızlı Kelime
Kartları 45 saniye sonunda veya Durdur seçildiğinde sonucu gösterir.
İsim ve skor kaydı yalnızca bu sonuç penceresindedir.

## API

- `GET /api/health`
- `GET /api/scores?limit=20`
- `POST /api/scores`
- `POST /api/telemetry`

Örnek:

```bash
curl -X POST http://127.0.0.1:5500/api/scores \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-uuid","name":"Ayşe","correct":3,"total":5}'
```

Skor, oturum ve deneme verileri SQLite veritabanı olan
`data/games.sqlite3` dosyasında saklanır. Tablolar `sessions`, `scores` ve
`trials` olarak ayrılmıştır. Deneme metadata alanları JSON metni biçiminde
saklanırken hedef, seçilen yanıt, doğruluk, tepki süresi ve hata türü ayrı
sorgulanabilir sütunlardadır. Skorlar `sessionId` ile ilgili oturuma bağlanır.

İlk başlatmada eski `data/scores.json` ve `data/telemetry_sessions.jsonl`
kayıtları bir SQLite transaction'ı içinde veritabanına aktarılır. Aktarım
`schema_migrations` tablosunda kaydedildiği için sonraki başlatmalarda yinelenmez.
Kaynak JSON dosyaları yedek olarak bırakılır; yeni kayıtlar SQLite'a yazılır.
Veritabanı dosyasının konumu `DATABASE_PATH` ortam değişkeniyle değiştirilebilir.

Node backend için bağımlılıkları kurup başlatın:

```bash
npm install
npm run dev
```

SQLite CLI kuruluysa analiz örneği:

```sql
SELECT s.game_id, t.error_type, COUNT(*) AS trial_count,
       AVG(t.reaction_time_ms) AS avg_reaction_time_ms
FROM trials t
JOIN sessions s ON s.id = t.session_id
GROUP BY s.game_id, t.error_type;
```

Bu yerel prototipte SQLite dosyası şifrelenmez ve API kimlik doğrulaması yapmaz.
Gerçek kullanıcılarla, özellikle çocuklarla, kullanılmadan önce bilgilendirilmiş
onam, erişim kontrolü, saklama süresi ve yedekleme politikası belirlenmelidir.
Telemetri tek başına klinik tanı veya doğrulanmış risk taraması değildir.

## Alternatif (Node backend)
Node backend de aynı SQLite dosyasını ve şemayı kullanır.
