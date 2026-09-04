const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      try {
        const u = new URL(origin);
        const allowed = u.protocol === 'https:' && (u.hostname === 'www.czatuj24.pl' || u.hostname === 'czatuj24.pl');
        const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
        return callback(null, allowed || local);
      } catch { return callback(null, false); }
    },
    credentials: false
  },
  maxHttpBufferSize: 256 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 20000
});

const publicPath = path.join(__dirname, './');

/* ============================================================
   KANONICZNA DOMENA + PODSTAWOWE NAGŁÓWKI
   Produkcja: https://www.czatuj24.pl/
   Localhost pozostaje bez przekierowań.
============================================================ */
app.set('trust proxy', 1);

const CANONICAL_ORIGIN = 'https://www.czatuj24.pl';
const CANONICAL_HOST = 'www.czatuj24.pl';
const LEGACY_RENDER_HOST = /(?:^|\.)onrender\.com$/i;

app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal || req.path === '/healthz') return next();

  const isProductionHost = host === 'czatuj24.pl' || host === CANONICAL_HOST || LEGACY_RENDER_HOST.test(host);
  if (isProductionHost && (host !== CANONICAL_HOST || req.protocol !== 'https')) {
    return res.redirect(301, CANONICAL_ORIGIN + req.originalUrl);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.protocol === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// Google AdSense / ads.txt — publisher ID zostanie uzupełniony po otrzymaniu go z AdSense.
// Nie wolno wpisywać losowego ID, ponieważ Google wymaga dokładnie ID z konta wydawcy.
const ADS_TXT_PUBLISHER_ID = 'pub-5073295199353493';

const SITEMAP_URLS = [
  '/',
  '/anonimowy-czat',
  '/czat-1-na-1',
  '/czat-bez-rejestracji',
  '/czat-online',
  '/czat-z-nieznajomymi',
  '/gry-online-1-na-1',
  '/jak-dziala',
  '/faq',
  '/bezpieczenstwo',
  '/6obcy-alternatywa',
  '/kontakt',
  '/zasady',
  '/regulamin',
  '/polityka-prywatnosci'
];

app.get('/ads.txt', (req, res) => {
  const publisherId = String(ADS_TXT_PUBLISHER_ID).trim();
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (!/^pub-\d{16}$/.test(publisherId)) {
    return res.send('# Czatuj24 ads.txt\n# Uzupełnij ADS_TXT_PUBLISHER_ID dokładnym ID wydawcy z Google AdSense.\n');
  }
  return res.send(`google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
});

// Sitemap jest obsługiwany bezpośrednio przez Express przed middleware statycznym,
// dzięki czemu /sitemap.xml nigdy nie może zostać potraktowane jako index.html.
app.get('/sitemap.xml', (req, res) => {
  const body = SITEMAP_URLS
    .map(url => `  <url><loc>${CANONICAL_ORIGIN}${url}</loc></url>`)
    .join('\n');
  const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n${body}\n</urlset>\n`;
  res.status(200);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /uploads/',
    'Disallow: /healthz',
    '',
    `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`,
    ''
  ].join('\n'));
});

app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: Math.round(process.uptime()),
    online: io.engine.clientsCount
  });
});

app.use(express.static(publicPath, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// Dynamic/technical paths must never become accidental SEO landing pages.
app.use((req, res, next) => {
  if (/^\/(?:chat|room|rooms|match|socket|api)(?:\/|$)/i.test(req.path)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

/* ============================================================
   GOOGLE / SEO — ROBOTS, SITEMAP I PUBLICZNE STRONY
   Te adresy są lekkie, statyczne logicznie i nie korzystają z Socket.IO.
============================================================ */
const SEO_PAGES = {
  '/anonimowy-czat': {
    title: 'Anonimowy czat online bez rejestracji | Czatuj24',
    description: 'Anonimowy czat online bez rejestracji. Rozmawiaj 1 na 1 z losową osobą bez zakładania konta i bez logowania.',
    h1: 'Anonimowy czat online bez rejestracji',
    sections: [
      ['Anonimowa rozmowa 1 na 1', 'Czatuj24 łączy dwie osoby w bieżącej sesji rozmowy. Nie musisz zakładać konta ani tworzyć publicznego profilu.'],
      ['Jak rozpocząć czat?', 'Kliknij START, poczekaj na dopasowanie i rozpocznij rozmowę. Po zakończeniu możesz ponownie rozpocząć wyszukiwanie kolejnej osoby.'],
      ['Bez rejestracji i logowania', 'Podstawowe ustawienia profilu są przechowywane lokalnie w przeglądarce. Bieżącej rozmowie służą tylko informacje potrzebne do działania funkcji partnera.'],
      ['Prywatność i bezpieczeństwo', 'Nie podawaj haseł, adresu zamieszkania, danych płatniczych ani innych wrażliwych informacji. Możesz zgłosić naruszenie zasad i szybko zakończyć rozmowę.'],
      ['Dodatkowe funkcje', 'Podczas rozmowy dostępne są reakcje, jedno zdjęcie na sesję oraz gry 1 na 1, których uruchomienie wymaga akceptacji partnera.'],
      ['Dla kogo jest serwis?', 'Czatuj24 jest przeznaczone dla osób, które ukończyły 16 lat. Serwis nie deklaruje pełnej weryfikacji wieku ani tożsamości.']
    ]
  },
  '/czat-1-na-1': {
    title: 'Czat 1 na 1 z losową osobą online | Czatuj24',
    description: 'Czat 1 na 1 z losową osobą online. Zacznij rozmowę bez rejestracji, bez logowania i bez publicznego profilu.',
    h1: 'Czat 1 na 1 z losową osobą online',
    sections: [
      ['Rozmowa tylko z jednym partnerem', 'Po dopasowaniu otrzymujesz prywatną sesję 1 na 1. Kolejny partner jest wyszukiwany dopiero po zakończeniu bieżącej rozmowy.'],
      ['Prosty start', 'Nie musisz przechodzić przez rozbudowaną konfigurację. Ustaw lokalny profil, kliknij START i poczekaj na połączenie.'],
      ['Profil podczas sesji', 'Partner może zobaczyć wybrane informacje udostępniane na potrzeby rozmowy, takie jak nick, wiek, cel, status i biogram. Profil nie jest publiczną stroną.'],
      ['Zakończenie i kolejna rozmowa', 'STOP kończy bieżącą sesję. Następnie możesz wrócić do wyszukiwania kolejnej osoby.'],
      ['Bezpieczne korzystanie', 'Szanuj rozmówcę, nie wysyłaj treści seksualnych i korzystaj z funkcji zgłaszania, gdy ktoś narusza zasady.']
    ]
  },
  '/czat-bez-rejestracji': {
    title: 'Czat bez rejestracji i logowania | Czatuj24',
    description: 'Czat bez rejestracji i logowania. Rozmawiaj z losową osobą online bez zakładania konta.',
    h1: 'Czat bez rejestracji i logowania',
    sections: [
      ['Nie zakładasz konta', 'Czatuj24 nie wymaga klasycznej rejestracji konta. Możesz rozpocząć rozmowę bez podawania imienia czy tworzenia publicznego profilu.'],
      ['Ustawienia zapisane lokalnie', 'Wybrane ustawienia profilu i lokalne statystyki są przechowywane w przeglądarce użytkownika.'],
      ['Co dzieje się podczas rozmowy?', 'System dopasowuje dostępne osoby i utrzymuje bieżącą sesję 1 na 1. Po zakończeniu stan rozmowy jest czyszczony.'],
      ['Bezpieczeństwo', 'Brak rejestracji nie oznacza pełnej anonimowości technicznej. Infrastruktura może przetwarzać dane potrzebne do działania i ochrony serwisu.']
    ]
  },
  '/czat-online': {
    title: 'Czat online z losowymi osobami | Czatuj24',
    description: 'Darmowy czat online z losowymi osobami. Rozmowy 1 na 1 bez rejestracji i bez logowania.',
    h1: 'Darmowy czat online z losowymi osobami',
    sections: [
      ['Losowe dopasowanie', 'Kliknięcie START dodaje Cię do kolejki. Gdy znajdzie się druga dostępna osoba, serwis łączy Was w rozmowę 1 na 1.'],
      ['Rozmowa w przeglądarce', 'Czat działa bez instalowania osobnej aplikacji. Interfejs jest przygotowany do korzystania na telefonie i komputerze.'],
      ['Funkcje rozmowy', 'Możesz wysyłać wiadomości, reagować, korzystać z profilu sesyjnego, wysłać jedno zdjęcie i zaprosić partnera do gry.'],
      ['Masz kontrolę', 'Rozmowę można zakończyć, a naruszenia zasad można zgłosić.']
    ]
  },
  '/czat-z-nieznajomymi': {
    title: 'Czat z nieznajomymi online | Czatuj24',
    description: 'Czat z nieznajomymi online w formule 1 na 1. Rozmawiaj z losowo dobraną osobą bez rejestracji.',
    h1: 'Czat z nieznajomymi online',
    sections: [
      ['Rozmawiaj z nowymi osobami', 'Czatuj24 służy do spontanicznych rozmów 1 na 1 z losowo dobranym rozmówcą.'],
      ['Nie musisz ujawniać tożsamości', 'Do rozpoczęcia rozmowy nie potrzebujesz konta ani publicznego profilu. Mimo to nie udostępniaj wrażliwych danych osobom poznanym w internecie.'],
      ['Szanuj granice', 'Każda osoba może zakończyć rozmowę. Nie nękaj, nie groź i nie naciskaj na rozmówcę.'],
      ['Bez treści seksualnych', 'Czatuj24 nie jest serwisem erotycznym. Zabronione są treści seksualne, pornograficzne i intymne oraz nakłanianie do ich przesyłania.']
    ]
  },
  '/gry-online-1-na-1': {
    title: 'Gry online dla 2 osób podczas czatu | Czatuj24',
    description: 'Gry online dla dwóch osób podczas rozmowy: kółko i krzyżyk, kamień papier nożyce, rysuj i zgaduj, łańcuch słów, refleks i Ryzykant.',
    h1: 'Gry online dla 2 osób podczas czatu',
    sections: [
      ['Kółko i krzyżyk', 'Klasyczna gra dla dwóch osób. Serwer pilnuje planszy i kolejności ruchów.'],
      ['Kamień, papier, nożyce', 'Wybory są ukryte do momentu, gdy obie osoby dokonają ruchu. Gra składa się z pięciu rund.'],
      ['Rysuj i zgaduj', 'Jedna osoba rysuje w czasie rzeczywistym, a druga próbuje odgadnąć hasło. Kolejne rundy zmieniają role.'],
      ['Łańcuch słów', 'Gracze naprzemiennie dodają słowa zgodnie z aktualną literą. Serwer sprawdza kolejkę i powtórzenia.'],
      ['Refleks', 'Obie osoby potwierdzają gotowość, a następnie reagują na sygnał. Wynik opiera się na czasie reakcji.'],
      ['Ryzykant', 'Odkrywasz zakryte pola z dodatnimi lub ujemnymi wartościami i decydujesz, czy ryzykujesz dalej, czy zachowujesz wynik.'],
      ['Jak zaprosić?', 'Wybierz grę z katalogu podczas aktywnej rozmowy. Partner musi zaakceptować zaproszenie, zanim gra się rozpocznie.']
    ]
  },
  '/6obcy-alternatywa': {
    title: 'Alternatywa dla 6obcy – anonimowy czat 1 na 1 | Czatuj24',
    description: 'Szukasz alternatywy dla 6obcy? Czatuj24 oferuje anonimowe rozmowy 1 na 1 bez klasycznej rejestracji, z dodatkowymi funkcjami i zasadami bezpieczeństwa.',
    h1: 'Alternatywa dla 6obcy – anonimowy czat 1 na 1',
    sections: [
      ['Czym jest Czatuj24?', 'Czatuj24 to niezależny polski serwis do losowych rozmów 1 na 1. Nie jest oficjalnym serwisem 6obcy i nie jest z nim powiązany.'],
      ['Podobna intencja, własne funkcje', 'Jeśli szukasz miejsca do spontanicznej rozmowy z nieznajomą osobą, Czatuj24 oferuje dopasowanie 1 na 1 bez klasycznej rejestracji, lokalny profil, reakcje i gry.'],
      ['Co wyróżnia Czatuj24?', 'Poza samą rozmową dostępne są gry 1 na 1, możliwość wysłania jednego zdjęcia na sesję, zgłaszanie nadużyć oraz proste zakończenie rozmowy i wyszukanie kolejnego partnera.'],
      ['Prywatność', 'Profil nie jest publicznym katalogiem. Wybrane informacje profilowe są udostępniane partnerowi tylko na potrzeby bieżącej sesji.'],
      ['Bezpieczeństwo', 'Serwis jest przeznaczony dla osób 16+. Zabronione są treści erotyczne, pornograficzne i intymne. Użytkownik może zgłosić naruszenie zasad.'],
      ['Ważne rozróżnienie', 'Czatuj24 nie używa nazwy, identyfikacji wizualnej ani komunikatów sugerujących oficjalne powiązanie z marką 6obcy. Określenie „alternatywa dla 6obcy” służy wyłącznie opisowi kategorii i intencji wyszukiwania.']
    ]
  },
  '/jak-dziala': {
    title: 'Jak działa anonimowy czat 1 na 1? | Czatuj24',
    description: 'Dowiedz się, jak działa anonimowy czat 1 na 1 Czatuj24: START, losowe dopasowanie, rozmowa, STOP, profil lokalny i bezpieczeństwo.',
    h1: 'Jak działa anonimowy czat 1 na 1?',
    sections: [
      ['1. Wejdź na Czatuj24', 'Serwis działa bez klasycznej rejestracji konta. Ustawienia profilu możesz przygotować lokalnie w przeglądarce.'],
      ['2. Kliknij START', 'Po kliknięciu START system wyszukuje dostępną osobę i tworzy połączenie 1 na 1.'],
      ['3. Rozpocznij rozmowę', 'Po znalezieniu partnera możesz wysyłać wiadomości, reakcje, jedno zdjęcie na sesję i zaproszenia do gier.'],
      ['4. Zadbaj o prywatność', 'Nie podawaj haseł, danych płatniczych, adresu zamieszkania ani dokumentów. Profil nie jest publicznym katalogiem.'],
      ['5. Zakończ lub zgłoś', 'STOP kończy rozmowę. Jeśli partner narusza zasady, użyj funkcji zgłoszenia.']
    ]
  },
  '/faq': {
    title: 'FAQ – anonimowy czat bez rejestracji | Czatuj24',
    description: 'FAQ Czatuj24: rejestracja, anonimowość, rozmowy 1 na 1, zdjęcia, gry, bezpieczeństwo, prywatność i minimalny wiek.',
    h1: 'FAQ – anonimowy czat bez rejestracji',
    sections: [
      ['Czy Czatuj24 jest darmowy?', 'Podstawowe korzystanie z czatu jest bezpłatne. Serwis może wyświetlać reklamy.'],
      ['Czy trzeba się rejestrować?', 'Nie. Do rozpoczęcia rozmowy nie jest wymagane klasyczne konto ani logowanie.'],
      ['Czy trzeba podawać imię?', 'Nie. Możesz korzystać z nicku. Nie udostępniaj jednak danych, których nie chcesz ujawniać obcej osobie.'],
      ['Czy Czatuj24 jest anonimowy?', 'Serwis nie wymaga klasycznej rejestracji, ale nie oznacza to pełnej anonimowości technicznej. Infrastruktura może przetwarzać dane potrzebne do działania i bezpieczeństwa.'],
      ['Jak rozpocząć rozmowę?', 'Kliknij START i poczekaj na dopasowanie.'],
      ['Jak znaleźć nowego rozmówcę?', 'Zakończ bieżącą rozmowę przyciskiem STOP, a następnie rozpocznij kolejne wyszukiwanie.'],
      ['Czy można zakończyć rozmowę?', 'Tak. STOP kończy bieżącą sesję.'],
      ['Czy rozmowy są zapisywane?', 'Standardowa rozmowa służy bieżącej sesji i nie jest prowadzona jako trwała historia dostępna po jej zakończeniu. Treści przekazane w zgłoszeniu mogą być przetwarzane na potrzeby bezpieczeństwa.'],
      ['Czy można zablokować użytkownika?', 'Serwis udostępnia mechanizmy bezpieczeństwa i zgłaszania. Bieżącą rozmowę można szybko zakończyć.'],
      ['Jak zgłosić użytkownika?', 'Podczas rozmowy użyj przycisku zgłoszenia i wybierz odpowiednią kategorię.'],
      ['Czy można wysyłać zdjęcia?', 'Tak, maksymalnie jedno zdjęcie na sesję. Zabronione są nagość i materiały intymne.'],
      ['Czy Czatuj24 działa na telefonie?', 'Tak. Interfejs jest przygotowany do korzystania na nowoczesnych telefonach i komputerach.'],
      ['Czy Czatuj24 działa na komputerze?', 'Tak, aplikacja działa w nowoczesnej przeglądarce.'],
      ['Czy można grać podczas rozmowy?', 'Tak. Dostępne są gry 1 na 1, a rozpoczęcie gry wymaga akceptacji partnera.'],
      ['Od jakiego wieku można korzystać z serwisu?', 'Od ukończenia 16 lat. Interfejs nie pozwala ustawić niższego wieku, ale serwis nie deklaruje pełnej weryfikacji wieku.'],
      ['Jak działa profil użytkownika?', 'Profil jest ustawieniem lokalnym. Podczas aktywnej sesji partner może otrzymać wybrane informacje profilowe przeznaczone do bieżącej rozmowy.'],
      ['Czy mój profil jest publiczny?', 'Nie. Nie ma publicznego katalogu profili użytkowników.']
    ]
  },
  '/bezpieczenstwo': {
    title: 'Bezpieczeństwo i anonimowość na Czatuj24',
    description: 'Zasady bezpiecznego korzystania z anonimowego czatu: prywatność, zgłaszanie, zdjęcia, treści seksualne i ochrona użytkowników 16+.',
    h1: 'Bezpieczeństwo i anonimowość na Czatuj24',
    sections: [
      ['Nie udostępniaj wrażliwych danych', 'Nie podawaj haseł, kodów, danych bankowych, dokumentów, adresu zamieszkania ani innych informacji, które mogą narazić Cię na szkodę.'],
      ['16+ i szczególna ochrona osób poniżej 18 lat', 'Korzystanie z serwisu jest dozwolone od ukończenia 16 lat. Osoby poniżej 18 lat wymagają szczególnej ochrony przed seksualizacją i naciskiem na przesyłanie intymnych materiałów.'],
      ['Zero treści seksualnych', 'Zabronione jest wysyłanie, proponowanie, nakłanianie lub wymuszanie wymiany treści erotycznych, pornograficznych albo intymnych.'],
      ['Zgłaszanie', 'Jeżeli partner narusza zasady, użyj zgłoszenia podczas rozmowy lub bezpośrednio po jej zakończeniu.'],
      ['Zakończenie rozmowy', 'Nie musisz kontynuować rozmowy. Użyj STOP, gdy chcesz zakończyć sesję.']
    ]
  },
  '/zasady': {
    title: 'Zasady Czatuj24 – bezpieczeństwo i kultura rozmowy',
    description: 'Zasady korzystania z Czatuj24: 16+, szacunek, zakaz treści seksualnych, prywatność, zdjęcia i zgłaszanie nadużyć.',
    h1: 'Zasady korzystania z Czatuj24',
    sections: [
      ['1. Minimalny wiek: 16 lat', 'Z serwisu mogą korzystać wyłącznie osoby, które ukończyły 16 lat.'],
      ['2. Szanuj rozmówcę', 'Nie groź, nie nękaj, nie obrażaj, nie spamuj i respektuj odmowę.'],
      ['3. Zakaz treści seksualnych', 'Czatuj24 nie jest serwisem erotycznym. Zabronione są treści erotyczne, pornograficzne i intymne oraz nakłanianie do ich przesyłania.'],
      ['4. Zdjęcia', 'Maksymalnie jedno zdjęcie na sesję. Nie wysyłaj nagości ani materiałów intymnych.'],
      ['5. Prywatność', 'Nie żądaj od innych danych wrażliwych i nie udostępniaj własnych danych, jeśli nie jest to konieczne.'],
      ['6. Zgłoszenia', 'Naruszenia zasad można zgłaszać w aplikacji.'],
      ['7. Gry', 'Zaproszenie do gry wymaga akceptacji drugiej osoby. Nie używaj gier do obchodzenia zasad bezpieczeństwa.']
    ]
  },
  '/regulamin': {
    title: 'Regulamin Czatuj24',
    description: 'Regulamin korzystania z Czatuj24: zakres usługi, wymagania wiekowe, zasady rozmów, zdjęć, gier, zgłoszeń i bezpieczeństwa.',
    h1: 'Regulamin Czatuj24',
    sections: [
      ['1. Charakter usługi', 'Czatuj24 udostępnia internetowy czat losowy 1 na 1 wraz z wybranymi funkcjami dodatkowymi.'],
      ['2. Wiek', 'Korzystanie z serwisu jest dozwolone wyłącznie osobom, które ukończyły 16 lat.'],
      ['3. Treści zabronione', 'Zabronione są treści seksualne, pornografia, nagość, materiały intymne, groźby, nękanie, spam, oszustwa i obchodzenie zabezpieczeń.'],
      ['4. Zdjęcia i gry', 'Jedna sesja pozwala na maksymalnie jedno zdjęcie. Gry są uruchamiane po zaakceptowaniu zaproszenia przez partnera.'],
      ['5. Moderacja i zgłoszenia', 'Serwis może ograniczać działania użytkowników i analizować zgłoszenia w zakresie potrzebnym do bezpieczeństwa.'],
      ['6. Dostępność', 'Działanie serwisu zależy od infrastruktury, połączenia internetowego i przeglądarki. Serwis nie gwarantuje nieprzerwanej dostępności.']
    ]
  },
  '/polityka-prywatnosci': {
    title: 'Polityka prywatności Czatuj24',
    description: 'Polityka prywatności Czatuj24: dane profilu, sesje rozmów, zgłoszenia, zdjęcia, localStorage, dane techniczne, reklamy i prawa użytkownika.',
    h1: 'Polityka prywatności Czatuj24',
    sections: [
      ['1. Informacje ogólne', 'Niniejsza polityka opisuje zasady przetwarzania danych związanych z korzystaniem z Czatuj24. Zakres faktycznego przetwarzania zależy od używanych funkcji i infrastruktury.'],
      ['2. Administrator i kontakt', 'Administratorem danych jest podmiot prowadzący serwis Czatuj24. Kontakt w sprawach prywatności, bezpieczeństwa i danych: kontaktczatuj24@gmail.com.'],
      ['3. Dane profilu', 'Ustawienia profilu są przechowywane lokalnie w przeglądarce. Podczas bieżącej sesji serwer może otrzymać nick, wiek, cel rozmowy, status i biogram przeznaczone do udostępnienia partnerowi.'],
      ['4. Wiadomości i sesja', 'Standardowy czat jest obsługiwany jako bieżąca sesja 1 na 1. Stan rozmowy jest czyszczony po jej zakończeniu; treści przekazane w zgłoszeniu mogą być przetwarzane w zakresie potrzebnym do bezpieczeństwa.'],
      ['5. Zgłoszenia', 'Zgłoszenia mogą zawierać kategorię, opis i informacje techniczne potrzebne do rozpatrzenia sprawy. Mogą być przechowywane przez okres niezbędny do obsługi bezpieczeństwa i ochrony serwisu.'],
      ['6. Zdjęcia', 'Zdjęcie wysłane podczas sesji jest obsługiwane przez serwer i może być technicznie zapisane w katalogu uploadów. Limit aplikacji to jedno zdjęcie na sesję.'],
      ['7. LocalStorage', 'Przeglądarka może przechowywać ustawienia profilu, zgodę, motyw, ustawienia dźwięku i lokalne statystyki aktywności.'],
      ['8. Dane techniczne', 'Infrastruktura może przetwarzać adres IP, user-agent, identyfikatory połączeń, znaczniki czasu i inne dane techniczne potrzebne do działania, diagnostyki i przeciwdziałania nadużyciom.'],
      ['9. Reklamy i Google AdSense', 'Czatuj24 korzysta z Google AdSense. Usługa reklamowa może używać cookies, identyfikatorów i innych danych technicznych zgodnie z własnymi zasadami oraz mechanizmami zgody i ustawieniami reklam.'],
      ['10. Odbiorcy danych', 'Dane mogą być przetwarzane przez dostawców hostingu, infrastruktury, komunikacji, usług technicznych i reklamowych, w zakresie wynikającym z rzeczywistej konfiguracji serwisu.'],
      ['11. Brak sprzedaży danych', 'Czatuj24 nie sprzedaje danych osobowych użytkowników. Nie wyklucza to przetwarzania danych przez dostawców usług niezbędnych do działania serwisu.'],
      ['12. Retencja', 'Okres przechowywania zależy od rodzaju danych i rzeczywistej konfiguracji usług. Dla zgłoszeń, uploadów i danych technicznych należy stosować okres niezbędny do odpowiedniego celu, obowiązków prawnych i bezpieczeństwa.'],
      ['13. Prawa użytkownika', 'W zakresie wynikającym z obowiązujących przepisów możesz żądać dostępu do danych, ich sprostowania, usunięcia lub ograniczenia przetwarzania, a także skorzystać z innych praw, gdy mają zastosowanie.'],
      ['14. Kontakt', 'W sprawach dotyczących danych osobowych skontaktuj się pod adresem kontaktczatuj24@gmail.com.'],
      ['15. Aktualizacje', 'Polityka może być aktualizowana wraz ze zmianami technicznymi, prawnymi lub organizacyjnymi serwisu.']
    ]
  },
  '/kontakt': {
    title: 'Kontakt – Czatuj24',
    description: 'Kontakt z Czatuj24 w sprawach technicznych, prywatności, bezpieczeństwa i zgłoszeń.',
    h1: 'Kontakt z Czatuj24',
    sections: [
      ['Kontakt główny', 'Adres: kontaktczatuj24@gmail.com. Możesz napisać w sprawie problemu technicznego, prywatności, bezpieczeństwa lub działania serwisu.'],
      ['Nadużycia', 'Jeśli problem dotyczy bieżącej rozmowy, w pierwszej kolejności użyj funkcji zgłoszenia dostępnej w aplikacji.'],
      ['Dane w zgłoszeniu', 'Podaj tylko informacje potrzebne do rozpatrzenia sprawy i nie przesyłaj zbędnych danych osobowych.']
    ]
  }
};
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSeoPage(req, res, page) {
  const pathName = req.path;
  const canonical = CANONICAL_ORIGIN + pathName;
  const sections = page.sections.map(([heading, text]) => `<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(text)}</p></section>`).join('');
  const links = [
    ['/', 'Strona główna'],
    ['/anonimowy-czat', 'Anonimowy czat'],
    ['/czat-1-na-1', 'Czat 1 na 1'],
    ['/czat-bez-rejestracji', 'Bez rejestracji'],
    ['/czat-online', 'Czat online'],
    ['/czat-z-nieznajomymi', 'Czat z nieznajomymi'],
    ['/gry-online-1-na-1', 'Gry 1 na 1'],
    ['/jak-dziala', 'Jak działa'],
    ['/faq', 'FAQ'],
    ['/bezpieczenstwo', 'Bezpieczeństwo'],
    ['/6obcy-alternatywa', 'Alternatywa dla 6obcy'],
    ['/kontakt', 'Kontakt'],
    ['/zasady', 'Zasady'],
    ['/regulamin', 'Regulamin'],
    ['/polityka-prywatnosci', 'Prywatność']
  ];
  const nav = links.map(([href,label]) => `<a href="${href}">${escapeHtml(label)}</a>`).join('');
  const breadcrumb = [
    {"@type":"ListItem","position":1,"name":"Czatuj24","item":CANONICAL_ORIGIN+'/'},
    {"@type":"ListItem","position":2,"name":page.h1,"item":canonical}
  ];
  const graph = [
    {"@type":"WebSite","name":"Czatuj24","url":CANONICAL_ORIGIN+'/',"inLanguage":"pl-PL"},
    {"@type":"WebApplication","name":"Czatuj24","url":CANONICAL_ORIGIN+'/',"applicationCategory":"CommunicationApplication","operatingSystem":"Web","inLanguage":"pl-PL"},
    {"@type":"BreadcrumbList","itemListElement":breadcrumb}
  ];
  if (pathName === '/faq') {
    graph.push({"@type":"FAQPage","mainEntity":page.sections.map(([name,text]) => ({"@type":"Question","name":name,"acceptedAnswer":{"@type":"Answer","text":text}}))});
  }
  const jsonLd = JSON.stringify({"@context":"https://schema.org","@graph":graph}).replace(/</g,'\\u003c');
  res.status(200).type('html').send(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"><meta name="description" content="${escapeHtml(page.description)}"><meta name="referrer" content="strict-origin-when-cross-origin"><link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="Czatuj24"><meta property="og:locale" content="pl_PL"><meta property="og:title" content="${escapeHtml(page.title)}"><meta property="og:description" content="${escapeHtml(page.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${CANONICAL_ORIGIN}/czatuj24-logo.png"><meta property="og:image:alt" content="Czatuj24"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(page.title)}"><meta name="twitter:description" content="${escapeHtml(page.description)}"><meta name="twitter:image" content="${CANONICAL_ORIGIN}/czatuj24-logo.png"><link rel="icon" href="/czatuj24-logo.png"><title>${escapeHtml(page.title)}</title><script type="application/ld+json">${jsonLd}</script><style>:root{color-scheme:dark;--g:#39ff14;--bg:#030703;--panel:#0a110b;--text:#effff0;--muted:#91a793;--line:rgba(57,255,20,.2)}*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0,rgba(57,255,20,.08),transparent 32%),linear-gradient(135deg,#010201,#071007 60%,#020402);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}main{width:min(920px,calc(100% - 28px));margin:0 auto;padding:30px 0 45px}.brand{display:inline-flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:900;font-size:1.2rem}.brand b{color:var(--g)}.hero,section{border:1px solid var(--line);background:rgba(10,17,11,.82);border-radius:20px;box-shadow:0 18px 60px rgba(0,0,0,.25)}.hero{padding:25px;margin:20px 0 12px}.hero h1{margin:0 0 8px;font-size:clamp(1.65rem,4vw,2.45rem);letter-spacing:-.04em;line-height:1.12}.hero p{margin:0;color:var(--muted)}section{padding:19px 21px;margin:10px 0}h2{margin:0 0 6px;font-size:1rem;color:var(--g)}section p{margin:0;color:#d8e6d9;font-size:.9rem}nav{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:16px;padding:14px 0;border-top:1px solid var(--line)}nav a{color:var(--g);text-decoration:none;font-size:.82rem}nav a:hover{text-decoration:underline}.note{margin-top:15px;color:var(--muted);font-size:.72rem}@media(max-width:600px){main{width:min(100% - 18px,920px);padding:18px 0 32px}.hero{padding:18px}.hero h1{font-size:1.55rem}section{padding:15px}section p{font-size:.82rem}nav{gap:7px 11px}nav a{font-size:.76rem}}</style></head><body><main><a class="brand" href="/">Czatuj<b>24</b></a><div class="hero"><h1>${escapeHtml(page.h1)}</h1><p>${escapeHtml(page.description)}</p></div>${sections}<nav aria-label="Informacje o Czatuj24">${nav}</nav><p class="note">Czatuj24 – darmowy czat online 1 na 1 bez rejestracji.</p></main></body></html>`);
}

for (const [route, page] of Object.entries(SEO_PAGES)) {
  app.get(route, (req, res) => renderSeoPage(req, res, page));
}

app.get(['/anonimowy-czat/', '/czat-1-na-1/', '/czat-bez-rejestracji/', '/czat-online/', '/czat-z-nieznajomymi/', '/gry-online-1-na-1/', '/jak-dziala/', '/faq/', '/bezpieczenstwo/', '/6obcy-alternatywa/', '/kontakt/', '/zasady/', '/regulamin/', '/polityka-prywatnosci/'], (req, res) => {
  return res.redirect(301, req.path.slice(0, -1));
});

/* ============================================================
   KONFIGURACJA
============================================================ */

const PORT = process.env.PORT || 3000;

const MAX_MESSAGE_LENGTH = 5000;
const MAX_REPORT_DETAILS = 500;

const MAX_PHOTOS_PER_SESSION = 1;
const MAX_PHOTO_SIZE = 8 * 1024 * 1024;


/* ============================================================
   UPLOADY
============================================================ */

const uploadFolder = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadFolder);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    const safeExt = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.avif'
    ].includes(ext)
      ? ext
      : '.img';

    const random = crypto.randomBytes(12).toString('hex');

    cb(
      null,
      `${Date.now()}-${random}${safeExt}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_PHOTO_SIZE,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif'
    ]);

    if (!allowed.has(file.mimetype)) {
      return cb(
        new Error('Dozwolone są tylko pliki graficzne.')
      );
    }

    cb(null, true);
  }
});

/* ============================================================
   SPRAWDZENIE PRAWDZIWEGO TYPU OBRAZU
============================================================ */

function isLikelyImageFile(filePath, mime) {
  try {
    const b = fs.readFileSync(filePath);

    if (mime === 'image/jpeg') {
      return (
        b.length >= 3 &&
        b[0] === 0xff &&
        b[1] === 0xd8 &&
        b[2] === 0xff
      );
    }

    if (mime === 'image/png') {
      return (
        b.length >= 8 &&
        b.slice(0, 8).toString('hex') ===
          '89504e470d0a1a0a'
      );
    }

    if (mime === 'image/gif') {
      return (
        b.length >= 6 &&
        ['GIF87a', 'GIF89a'].includes(
          b.slice(0, 6).toString('ascii')
        )
      );
    }

    if (mime === 'image/webp') {
      return (
        b.length >= 12 &&
        b.slice(0, 4).toString('ascii') === 'RIFF' &&
        b.slice(8, 12).toString('ascii') === 'WEBP'
      );
    }

    if (mime === 'image/avif') {
      return (
        b.length >= 16 &&
        b.slice(4, 12).toString('ascii') === 'ftyp' &&
        /avif|avis/i.test(
          b.slice(8, 32).toString('ascii')
        )
      );
    }

    return false;
  } catch {
    return false;
  }
}

/* ============================================================
   UPLOAD ZDJĘCIA
============================================================ */

app.post('/upload', (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  if (!allowBurst(uploadRate, ip, 6, 60_000)) return res.status(429).json({error:'Za dużo prób przesłania pliku. Spróbuj później.'});
  upload.single('photo')(req, res, err => {
    if (err) {
      return res.status(400).json({
        error:
          err.message ||
          'Nieprawidłowy plik.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Brak pliku.'
      });
    }

    if (
      !isLikelyImageFile(
        req.file.path,
        req.file.mimetype
      )
    ) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      return res.status(400).json({
        error:
          'Plik nie wygląda na prawidłowy obraz.'
      });
    }

    res.json({
      url:
        '/uploads/' +
        encodeURIComponent(
          req.file.filename
        )
    });
  });
});

app.use(
  '/uploads',
  express.static(uploadFolder, {
    fallthrough: false,
    maxAge: '1h',
    setHeaders: res => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'private, max-age=3600');
    }
  })
);

/* ============================================================
   404 — brak soft-404 do strony głównej
============================================================ */
app.use((req, res) => {
  res.status(404).type('html').send(`<!doctype html><html lang=\"pl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,follow\"><title>404 – Nie znaleziono strony | Czatuj24</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030703;color:#effff0;font-family:system-ui,sans-serif;padding:20px;text-align:center}main{max-width:620px;border:1px solid rgba(57,255,20,.2);border-radius:22px;padding:30px;background:#0a110b}h1{margin:0 0 8px;font-size:2rem}p{color:#91a793;line-height:1.6}a{color:#39ff14;font-weight:800}</style></head><body><main><h1>404</h1><p>Ta strona nie istnieje albo została przeniesiona.</p><a href=\"/\">Wróć do Czatuj24</a></main></body></html>`);
});

/* ============================================================
   MATCHMAKING
============================================================ */

let waitingUsers = [];

const pairs = Object.create(null);
const publicProfiles = new Map();
const chatMessageRegistry = new Map();
const messageReactions = new Map();

const photoCounts = new Map();

const reportedThisSession = new Set();

const lastPartnerForReport = new Map();

/* ============================================================
   OCHRONA PRZED K14
============================================================ */

const blockedTermRegex =
  /(^|[^a-z0-9])k\s*1\s*4([^a-z0-9]|$)/iu;

function containsBlockedTerm(text) {
  return blockedTermRegex.test(
    String(text || '').normalize('NFKC')
  );
}

/* ============================================================
   POMOCNICZE
============================================================ */

function isConnected(socketId) {
  return io.sockets.sockets.has(socketId);
}

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter(
    id => id !== socketId
  );
}

function getPartner(socketId) {
  const partnerId = pairs[socketId];

  if (
    !partnerId ||
    !isConnected(partnerId)
  ) {
    return null;
  }

  return partnerId;
}

function emitOnlineCount() {
  io.emit(
    'onlineCount',
    io.sockets.sockets.size
  );
}

function randomId() {
  return crypto.randomBytes(10).toString('hex');
}

/* ============================================================
   STABILNE MATCHMAKING / ROZŁĄCZENIA
   Jeden socket = jedna pozycja w kolejce. Jedna para = dwa sockety.
============================================================ */

function sanitizePublicProfile(profile){
  const p = profile && typeof profile === 'object' ? profile : {};
  const allowedPurposes = new Set(['randka','spotkanie','rozmowa']);
  const allowedStatuses = new Set(['dostepny','zaraz']);
  const age = Math.max(16, Math.min(100, Number(p.age) || 25));
  const purpose = allowedPurposes.has(p.purpose) ? p.purpose : 'rozmowa';
  return {
    nick: String(p.nick || 'Partner').trim().slice(0,20) || 'Partner',
    age,
    purpose,
    status: allowedStatuses.has(p.status) ? p.status : 'dostepny',
    bio: String(p.bio || '').trim().slice(0,200)
  };
}

function emitPartnerProfiles(a,b){
  if(isConnected(a)) io.to(a).emit('partnerProfile', publicProfiles.get(b) || sanitizePublicProfile(null));
  if(isConnected(b)) io.to(b).emit('partnerProfile', publicProfiles.get(a) || sanitizePublicProfile(null));
}

function clearChatMessageStateForPair(a,b){
  for(const [id,entry] of chatMessageRegistry){
    if((entry.a===a && entry.b===b)||(entry.a===b && entry.b===a)){
      chatMessageRegistry.delete(id);
      messageReactions.delete(id);
    }
  }
}

function removePairReferences(socketId) {
  const partnerId = pairs[socketId] || null;
  delete pairs[socketId];
  if (partnerId) delete pairs[partnerId];
  return partnerId;
}

function breakPair(socketId, notifyPartner = true) {
  removeFromWaiting(socketId);

  const partnerId = pairs[socketId] || null;

  // Zapamiętaj ostatniego partnera, aby zgłoszenie po zakończeniu
  // rozmowy nadal mogło trafić do właściwego socketu, jeśli istnieje.
  if (partnerId && isConnected(partnerId)) {
    lastPartnerForReport.set(partnerId, socketId);
  }

  // Gry/invity i efemeryczne reakcje zawsze kończymy razem z parą.
  clearGameForPair(socketId);
  clearInviteForPair(socketId);
  if(partnerId) clearChatMessageStateForPair(socketId, partnerId);
  publicProfiles.delete(socketId);

  if (partnerId && notifyPartner && isConnected(partnerId)) {
    io.to(partnerId).emit('partnerStopped');
  }

  removePairReferences(socketId);
  return partnerId;
}

function cleanWaitingQueue() {
  const seen = new Set();
  waitingUsers = waitingUsers.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return isConnected(id) && !pairs[id];
  });
}

function enqueueUser(socketId) {
  cleanWaitingQueue();
  if (!isConnected(socketId) || pairs[socketId]) return false;
  if (waitingUsers.includes(socketId)) return false;
  waitingUsers.push(socketId);
  return true;
}

function matchWaitingUser(socketId) {
  cleanWaitingQueue();
  if (!isConnected(socketId) || pairs[socketId]) return null;

  const ownIndex = waitingUsers.indexOf(socketId);
  if (ownIndex >= 0) waitingUsers.splice(ownIndex, 1);

  let partnerId = null;
  while (waitingUsers.length) {
    const candidate = waitingUsers.shift();
    if (
      candidate &&
      candidate !== socketId &&
      isConnected(candidate) &&
      !pairs[candidate]
    ) {
      partnerId = candidate;
      break;
    }
  }

  if (!partnerId) {
    enqueueUser(socketId);
    return null;
  }

  pairs[socketId] = partnerId;
  pairs[partnerId] = socketId;

  photoCounts.set(socketId, 0);
  photoCounts.set(partnerId, 0);

  io.to(socketId).emit('partnerFound');
  io.to(partnerId).emit('partnerFound');
  emitPartnerProfiles(socketId, partnerId);

  console.log(`Para utworzona: ${socketId} <-> ${partnerId}`);
  emitOnlineCount();
  return partnerId;
}

/* ============================================================
   ZGŁOSZENIA
============================================================ */

const reportsFile =
  path.join(__dirname, 'reports.json');

function saveReport(report) {
  let reports = [];

  try {
    if (fs.existsSync(reportsFile)) {
      const raw =
        fs.readFileSync(
          reportsFile,
          'utf8'
        );

      reports = JSON.parse(raw);

      if (!Array.isArray(reports)) {
        reports = [];
      }
    }
  } catch (err) {
    console.error(
      'Nie udało się odczytać reports.json:',
      err.message
    );

    reports = [];
  }

  reports.push(report);

  try {
    fs.writeFileSync(
      reportsFile,
      JSON.stringify(
        reports,
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    console.error(
      'Nie udało się zapisać reports.json:',
      err.message
    );
  }
}

/* ============================================================
   STAN GIER — CZYSTY SILNIK 1:1
   6 lekkich gier: drawguess, ttt, word, reflex, risk, rps
   Jedna sesja = jedna para. Serwer jest źródłem prawdy.
============================================================ */

const gameSessions = new Map();
const pendingInvites = new Map();
const gameRate = new Map();
const messageRate = new Map();
const reportRate = new Map();
const reactionRate = new Map();
const profileRate = new Map();
const chatControlRate = new Map();
const uploadRate = new Map();

const GAME_INVITE_TIMEOUT = 30 * 1000;
const GAME_MAX_DURATION = 10 * 60 * 1000;
const GAME_ACTION_COOLDOWN = 140;
const DRAW_ACTION_COOLDOWN = 32;
const DRAW_MAX_STROKES_PER_SECOND = 28;
const GAME_MAX_ROUNDS = 8;
const DRAW_MAX_ROUNDS = 5;
const RISK_MAX_PICKS_PER_TURN = 2;

const GAME_NAMES = {
  drawguess: 'Rysuj i zgaduj',
  ttt: 'Kółko i krzyżyk',
  word: 'Łańcuch słów',
  reflex: 'Refleks',
  risk: 'Ryzykant',
  rps: 'Kamień, papier, nożyce'
};
const ALLOWED_GAMES = new Set(Object.keys(GAME_NAMES));

const DRAW_WORDS = [
  'lew','samochód','dom','rower','słońce','rakieta','pizza','kot','pies','drzewo',
  'statek','zamek','telefon','gitara','robot','smok','tęcza','lody','kawa','okulary',
  'piłka','księżyc','gwiazda','dinozaur','samolot','komputer','parasol','zegarek','aparat','motyl',
  'zamek','most','kaktus','tort','balon','mikrofon','gitara','pociąg','latarnia','plecak',
  'kapelusz','rak','sowa','rekin','żaba','małpa','wulkan','chmura','śnieg','deszcz',
  'lampa','krzesło','stół','zegarek','kamera','rakieta','książka','korona','pirat','statek'
];

const WORD_STARTS = ['DOM','KOT','LAS','MORZE','LATO','KAWA','ROBOT','SAMOCHÓD','PIŁKA','ZAMEK'];

function gameError(socket, message) { socket.emit('game:error', { message: String(message || 'Błąd gry.') }); }
function validateGameName(game) { return typeof game === 'string' && ALLOWED_GAMES.has(game); }

function getGameSession(socketId) {
  const s = gameSessions.get(socketId);
  if (!s) return null;
  const expectedPartner = s.a === socketId ? s.b : s.a;
  const actualPartner = getPartner(socketId);
  if (!expectedPartner || actualPartner !== expectedPartner) {
    clearGameForPair(socketId);
    return null;
  }
  return s;
}

function clearGameTimeout(session) {
  if (session?.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
  if (session?.timers) {
    for (const t of session.timers) clearTimeout(t);
    session.timers.clear();
  }
}

function clearGameForPair(socketId) {
  const session = gameSessions.get(socketId);
  if (!session) return;
  clearGameTimeout(session);
  gameSessions.delete(session.a);
  gameSessions.delete(session.b);
}

function emitGame(socketId, state) {
  if (isConnected(socketId)) io.to(socketId).emit('game:state', state);
}
function emitPair(session, makeState) {
  if (!session) return;
  emitGame(session.a, typeof makeState === 'function' ? makeState(session.a) : makeState);
  emitGame(session.b, typeof makeState === 'function' ? makeState(session.b) : makeState);
}

function finishGame(session, result = 'Gra zakończona.', extra = {}) {
  if (!session || !gameSessions.has(session.a)) return;
  session.active = false;
  clearGameTimeout(session);

  const winnerId = extra && Object.prototype.hasOwnProperty.call(extra, 'winner')
    ? extra.winner
    : null;
  const { winner, ...safeExtra } = extra || {};

  emitPair(session, id => {
    const state = {
      game: session.game,
      sessionId: session.id,
      active: false,
      finished: true,
      status: result,
      result,
      scores: safeExtra.scores || session.scores,
      ...safeExtra,
      winnerView: winnerId
        ? (winnerId === id ? 'self' : 'partner')
        : (winnerId === null && Object.prototype.hasOwnProperty.call(extra || {}, 'winner') ? 'draw' : null)
    };
    return state;
  });

  emitPair(session, id => {
    if (isConnected(id)) io.to(id).emit('game:finished', {
      game: session.game,
      sessionId: session.id,
      result,
      winnerView: winnerId ? (winnerId === id ? 'self' : 'partner') : (winnerId === null && Object.prototype.hasOwnProperty.call(extra || {}, 'winner') ? 'draw' : null)
    });
  });

  clearGameForPair(session.a);
}

function createGame(a, game) {
  const b = getPartner(a);
  if (!b || !validateGameName(game)) return null;
  const session = {
    id: randomId(),
    game,
    a,
    b,
    partnerId: b,
    createdAt: Date.now(),
    active: true,
    round: 1,
    scores: { [a]: 0, [b]: 0 },
    data: Object.create(null),
    timeout: null,
    timers: new Set()
  };
  gameSessions.set(a, session);
  gameSessions.set(b, session);
  session.timeout = setTimeout(() => finishGame(session, 'Czas gry minął.'), GAME_MAX_DURATION);
  return session;
}

function allowGameAction(socketId, game, action) {
  const now = Date.now();
  const key = `${socketId}:${game}:${action}`;
  const previous = gameRate.get(key) || 0;
  const cooldown = game === 'drawguess' && action === 'stroke' ? DRAW_ACTION_COOLDOWN : GAME_ACTION_COOLDOWN;
  if (now - previous < cooldown) return false;
  gameRate.set(key, now);
  return true;
}

function clearInviteForPair(socketId) {
  const invite = pendingInvites.get(socketId);
  if (!invite) return;
  if (invite.timer) clearTimeout(invite.timer);
  pendingInvites.delete(invite.from);
  pendingInvites.delete(invite.to);
}

function sendInvite(socket, game) {
  const partnerId = getPartner(socket.id);
  if (!partnerId) return gameError(socket, 'Najpierw połącz się z partnerem.');
  if (!validateGameName(game)) return gameError(socket, 'Nieprawidłowa gra.');
  if (gameSessions.has(socket.id) || gameSessions.has(partnerId)) return gameError(socket, 'Najpierw zakończ aktualną grę.');
  if (pendingInvites.has(socket.id) || pendingInvites.has(partnerId)) return gameError(socket, 'Jedno zaproszenie jest już oczekujące.');
  if (!allowGameAction(socket.id, 'invite', game)) return gameError(socket, 'Odczekaj chwilę przed kolejnym zaproszeniem.');

  const invite = { id: randomId(), game, from: socket.id, to: partnerId, createdAt: Date.now(), timer: null };
  invite.timer = setTimeout(() => {
    const current = pendingInvites.get(invite.to);
    if (!current || current.id !== invite.id) return;
    clearInviteForPair(invite.from);
    if (isConnected(invite.from)) io.to(invite.from).emit('game:inviteExpired', { game });
    if (isConnected(invite.to)) io.to(invite.to).emit('game:inviteExpired', { game });
  }, GAME_INVITE_TIMEOUT);

  pendingInvites.set(invite.from, invite);
  pendingInvites.set(invite.to, invite);
  socket.emit('game:inviteSent', { game, inviteId: invite.id });
  io.to(partnerId).emit('game:invite', { game, inviteId: invite.id });
}

function handleInviteResponse(socket, data) {
  if (!data || typeof data.game !== 'string') return;
  const invite = pendingInvites.get(socket.id);
  if (!invite || invite.id !== data.inviteId || invite.to !== socket.id || invite.game !== data.game) {
    return gameError(socket, 'Zaproszenie wygasło lub nie istnieje.');
  }
  clearInviteForPair(invite.from);
  const accepted = data.accepted === true;
  const inviter = invite.from;
  const partner = invite.to;
  if (!accepted) {
    if (isConnected(inviter)) io.to(inviter).emit('game:inviteResponse', { game: invite.game, accepted: false });
    if (isConnected(partner)) io.to(partner).emit('game:inviteResponse', { game: invite.game, accepted: false });
    return;
  }
  if (getPartner(inviter) !== partner || getPartner(partner) !== inviter) {
    return gameError(socket, 'Połączenie z partnerem zostało zakończone.');
  }
  if (gameSessions.has(inviter) || gameSessions.has(partner)) return gameError(socket, 'Gra została już uruchomiona.');

  const session = createGame(inviter, invite.game);
  if (!session) return gameError(socket, 'Nie udało się rozpocząć gry.');

  io.to(inviter).emit('game:inviteResponse', { game: invite.game, accepted: true, sessionId: session.id });
  io.to(partner).emit('game:inviteResponse', { game: invite.game, accepted: true, sessionId: session.id });
  initializeGame(session);
  io.to(inviter).emit('game:started', { game: invite.game, sessionId: session.id });
  io.to(partner).emit('game:started', { game: invite.game, sessionId: session.id });
}

function normalizeAnswer(value) {
  return String(value || '').toLocaleLowerCase('pl-PL').normalize('NFKC').replace(/[^a-z0-9ąćęłńóśźż\s-]/giu, '').trim().slice(0, 100);
}
function normalizeWord(value) {
  return String(value || '').toLocaleLowerCase('pl-PL').normalize('NFKC').replace(/[^a-ząćęłńóśźż]/g, '').slice(0, 40);
}

function checkTTT(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line: [a,b,c] };
  return board.every(Boolean) ? { winner: 'draw', line: [] } : null;
}

function drawStateFor(session, socketId, extra = {}) {
  const role = socketId === session.data.drawer ? 'drawer' : 'guesser';
  const scores = { ...session.scores };
  return {
    game: 'drawguess',
    sessionId: session.id,
    active: session.active,
    round: session.round,
    maxRounds: DRAW_MAX_ROUNDS,
    role,
    status: role === 'drawer' ? 'Rysuj hasło.' : 'Zgadnij, co partner rysuje.',
    word: role === 'drawer' ? session.data.word : undefined,
    scores,
    resetCanvas: !!extra.resetCanvas,
    ...extra
  };
}

function initializeGame(session) {
  const { a, b, game } = session;
  if (game === 'ttt') {
    session.data.board = Array(9).fill('');
    session.data.turn = a;
    session.data.symbols = { [a]: 'X', [b]: 'O' };
    emitPair(session, id => ({ game:'ttt', sessionId:session.id, active:true, board:session.data.board.slice(), turn:session.data.turn, symbol:session.data.symbols[id], status:id===session.data.turn?'Twój ruch':'Czekasz na ruch partnera.' }));
    return;
  }
  if (game === 'drawguess') {
    session.round = 1;
    session.data.drawer = Math.random() < .5 ? a : b;
    session.data.guesser = session.data.drawer === a ? b : a;
    session.data.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
    session.data.guessLocked = false;
    emitGame(a, drawStateFor(session, a, { resetCanvas:true }));
    emitGame(b, drawStateFor(session, b, { resetCanvas:true }));
    return;
  }
  if (game === 'word') {
    const start = WORD_STARTS[Math.floor(Math.random()*WORD_STARTS.length)];
    session.data.chain = [start];
    session.data.last = start;
    session.data.turn = Math.random() < .5 ? a : b;
    session.data.used = new Set([start.toLocaleLowerCase('pl-PL')]);
    emitPair(session, id => ({ game:'word', sessionId:session.id, active:true, chain:session.data.chain.slice(), myTurn:id===session.data.turn, status:id===session.data.turn?'Twój ruch':'Czekasz na partnera.' }));
    return;
  }
  if (game === 'reflex') {
    session.data.ready = new Set();
    session.data.clicked = Object.create(null);
    session.data.phase = 'ready';
    emitPair(session, id => ({ game:'reflex', sessionId:session.id, active:true, phase:'ready', ready:session.data.ready.has(id), status:session.data.ready.has(id)?'Gotowość zapisana. Czekamy na partnera.':'Kliknij GOTOWY, aby rozpocząć.' }));
    return;
  }
  if (game === 'risk') {
    session.round = 1;
    session.data.values = [1,3,5,-2,-5].sort(()=>Math.random()-.5);
    session.data.selected = Object.create(null);
    session.data.revealed = Object.create(null);
    session.data.picks = { [a]:0, [b]:0 };
    session.data.bank = { [a]:0, [b]:0 };
    session.data.turn = Math.random() < .5 ? a : b;
    emitPair(session, id => ({
      game:'risk', sessionId:session.id, active:true, round:1,
      score:session.data.bank[id],
      opponentScore:session.data.bank[id === a ? b : a],
      scores:{...session.data.bank},
      myTurn:id===session.data.turn,
      picksLeft:RISK_MAX_PICKS_PER_TURN,
      status:id===session.data.turn?'Twój ruch — wybierz zakryte pole.':'Czekasz na wybór partnera.',
      newRound:true
    }));
    return;
  }
  if (game === 'rps') {
    session.round = 1;
    session.data.choices = Object.create(null);
    session.data.score = { [a]:0, [b]:0 };
    emitPair(session, id => ({ game:'rps', sessionId:session.id, active:true, round:1, choice:null, score:session.data.score, status:'Wybierz swój ruch. Twój wybór jest ukryty do czasu wyboru obu osób.' }));
  }
}

function handleTTT(socket, session, data) {
  if (data.action !== 'move') return;
  const index = Number(data.index);
  if (!Number.isInteger(index) || index < 0 || index > 8) return;
  const symbol = session.data.symbols[socket.id];
  if (!symbol || session.data.turn !== socket.id || session.data.board[index]) return;
  session.data.board[index] = symbol;
  const result = checkTTT(session.data.board);
  if (result) {
    if (result.winner !== 'draw') session.scores[Object.keys(session.data.symbols).find(id => session.data.symbols[id] === result.winner)]++;
    finishGame(session, result.winner === 'draw' ? 'Remis.' : `Wygrywa ${result.winner}.`, { board:session.data.board.slice(), winning:result.line });
    return;
  }
  session.data.turn = session.data.turn === session.a ? session.b : session.a;
  emitPair(session, id => ({ game:'ttt', sessionId:session.id, active:true, board:session.data.board.slice(), turn:session.data.turn, symbol:session.data.symbols[id], status:id===session.data.turn?'Twój ruch':'Czekasz na ruch partnera.' }));
}

function rotateDrawRound(session, winnerId) {
  if (!session.active) return;
  if (winnerId) {
    session.scores[winnerId] += 2; // zgadujący
    const drawer = session.data.drawer;
    session.scores[drawer] += 1;   // rysujący
  }
  if (session.round >= DRAW_MAX_ROUNDS) {
    const winner = session.scores[session.a] === session.scores[session.b]
      ? null
      : (session.scores[session.a] > session.scores[session.b] ? session.a : session.b);
    const result = winner ? 'Rysuj i zgaduj zakończone — mamy zwycięzcę.' : 'Rysuj i zgaduj zakończone — remis.';
    finishGame(session, result, {
      scores:{...session.scores},
      winner,
      round:session.round,
      word: winnerId ? session.data.word : undefined
    });
    return;
  }

  const previousDrawer = session.data.drawer;
  session.data.drawer = previousDrawer === session.a ? session.b : session.a;
  session.data.guesser = session.data.drawer === session.a ? session.b : session.a;
  session.data.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  session.round += 1;
  session.data.guessLocked = false;

  emitGame(session.a, drawStateFor(session, session.a, { resetCanvas:true, result: winnerId ? 'Punkt za trafienie. Nowa runda.' : 'Nowa runda.' }));
  emitGame(session.b, drawStateFor(session, session.b, { resetCanvas:true, result: winnerId ? 'Punkt za trafienie. Nowa runda.' : 'Nowa runda.' }));
}

function handleDraw(socket, session, data) {
  if (data.action === 'stroke') {
    if (socket.id !== session.data.drawer) return;
    if (!allowBurst(gameRate, `${socket.id}:draw-stroke`, DRAW_MAX_STROKES_PER_SECOND, 1000)) return;
    const from = data.from, to = data.to;
    if (!from || !to) return;
    const clean = p => ({
      x: Math.max(0, Math.min(1, Number(p.x) || 0)),
      y: Math.max(0, Math.min(1, Number(p.y) || 0))
    });
    const width = Math.max(1, Math.min(24, Number(data.width)||5));
    const allowedColors = new Set(['#111611','#39ff14','#2878ff','#ff5362','#ffc24c','#fff']);
    const color = allowedColors.has(data.color) ? data.color : '#111611';
    emitGame(session.data.guesser, {
      game:'drawguess', sessionId:session.id, active:true, action:'stroke',
      from:clean(from), to:clean(to), width, color
    });
    return;
  }

  if (data.action === 'clear') {
    if (socket.id !== session.data.drawer) return;
    emitGame(session.data.guesser, { game:'drawguess', sessionId:session.id, active:true, action:'clear' });
    return;
  }

  if (data.action === 'guess') {
    if (socket.id !== session.data.guesser || session.data.guessLocked) return;
    const answer = normalizeAnswer(data.answer);
    if (!answer || answer.length > 60) return;
    const target = normalizeAnswer(session.data.word);
    const correct = answer === target || answer.includes(target) || target.includes(answer);

    if (correct) {
      session.data.guessLocked = true;
      rotateDrawRound(session, socket.id);
    } else {
      emitGame(socket.id, {
        game:'drawguess',
        sessionId:session.id,
        active:true,
        status:'Nie tym razem — próbuj dalej.',
        result:'Nie tym razem.'
      });
    }
  }
}

function handleWord(socket, session, data) {
  if (data.action !== 'add') return;
  if (session.data.turn !== socket.id) return gameError(socket, 'Teraz kolej partnera.');
  const word = normalizeWord(data.word);
  if (word.length < 2) return gameError(socket, 'Podaj poprawne słowo.');
  if (containsBlockedTerm(word)) return gameError(socket, 'To słowo nie może zostać użyte.');
  if (session.data.used.has(word)) return gameError(socket, 'To słowo już było użyte.');
  const required = session.data.last.slice(-1).toLocaleLowerCase('pl-PL');
  if (word[0] !== required) return gameError(socket, `Słowo musi zaczynać się na: ${required.toUpperCase()}`);
  session.data.chain.push(word);
  session.data.used.add(word);
  session.data.last = word;
  session.round = session.data.chain.length;
  if (session.data.chain.length >= GAME_MAX_ROUNDS) {
    finishGame(session, 'Łańcuch zakończony — osiągnięto limit ruchów.', { chain:session.data.chain.slice() });
    return;
  }
  session.data.turn = socket.id === session.a ? session.b : session.a;
  emitPair(session, id => ({ game:'word', sessionId:session.id, active:true, chain:session.data.chain.slice(), myTurn:id===session.data.turn, status:id===session.data.turn?'Twój ruch':'Czekasz na partnera.' }));
}

function handleReflex(socket, session, data) {
  if (data.action === 'ready') {
    if (session.data.phase !== 'ready') return;
    session.data.ready.add(socket.id);

    if (session.data.ready.size < 2) {
      emitGame(socket.id, {
        game:'reflex', sessionId:session.id, active:true, phase:'ready',
        ready:true, status:'Gotowość zapisana. Czekamy na partnera.'
      });
      return;
    }

    session.data.phase = 'countdown';
    emitPair(session, { game:'reflex', sessionId:session.id, active:true, phase:'countdown', count:3, status:'3' });

    [2,1].forEach((n, i) => {
      session.timers.add(setTimeout(() => {
        if (!session.active || session.data.phase !== 'countdown') return;
        emitPair(session, {game:'reflex',sessionId:session.id,active:true,phase:'countdown',count:n,status:String(n)});
      }, (i + 1) * 650));
    });

    const delay = 1950 + Math.floor(Math.random()*2600);
    session.timers.add(setTimeout(() => {
      if (!session.active || session.data.phase !== 'countdown') return;
      session.data.phase = 'signal';
      session.data.signalAt = Date.now();
      session.data.clicked = Object.create(null);
      emitPair(session, {
        game:'reflex',
        sessionId:session.id,
        active:true,
        phase:'signal',
        status:'KLIKNIJ!',
        signalAt:session.data.signalAt
      });

      session.timers.add(setTimeout(() => {
        if (!session.active || session.data.phase !== 'signal') return;
        const [a,b] = [session.a,session.b];
        const ra = session.data.clicked[a];
        const rb = session.data.clicked[b];
        if (ra === undefined || rb === undefined) {
          const winner = ra === undefined && rb === undefined ? null : (ra === undefined ? b : a);
          if (winner) session.scores[winner] += 1;
          finishGame(session, 'Refleks zakończony — nie każdy zdążył kliknąć.', {
            reactions:{[a]:ra ?? null,[b]:rb ?? null},
            winner
          });
        }
      }, 6000));
    }, delay));
    return;
  }

  if (data.action === 'click') {
    if (session.data.phase !== 'signal' || session.data.clicked[socket.id] !== undefined) return;
    const reaction = Math.max(0, Date.now() - session.data.signalAt);
    session.data.clicked[socket.id] = reaction;

    emitGame(socket.id, {
      game:'reflex',
      sessionId:session.id,
      active:true,
      phase:'waiting',
      reaction,
      status:`Twój czas: ${reaction} ms. Czekamy na partnera.`
    });

    if (Object.keys(session.data.clicked).length < 2) return;

    const [a,b] = [session.a,session.b];
    const ra = session.data.clicked[a], rb = session.data.clicked[b];
    const winner = ra === rb ? null : (ra < rb ? a : b);
    if (winner) session.scores[winner]++;
    finishGame(session, winner ? 'Refleks zakończony — mamy zwycięzcę.' : 'Refleks zakończony — remis.', {
      reactions:{ [a]:ra, [b]:rb },
      winner,
      scores:{...session.scores}
    });
  }
}

function emitRiskState(session, result = '') {
  emitPair(session, id => {
    const other = id === session.a ? session.b : session.a;
    const picks = session.data.picks[id] || 0;
    return {
      game:'risk',
      sessionId:session.id,
      active:session.active,
      round:session.round,
      score:session.data.bank[id],
      opponentScore:session.data.bank[other],
      scores:{...session.data.bank},
      myTurn:id===session.data.turn,
      picksUsed:picks,
      picksLeft:Math.max(0, RISK_MAX_PICKS_PER_TURN - picks),
      status:id===session.data.turn
        ? (picks >= RISK_MAX_PICKS_PER_TURN ? 'Limit ryzyka wykorzystany — przekazanie tury.' : 'Twój ruch — wybierz zakryte pole.')
        : 'Czekasz na ruch partnera.',
      newRound:true,
      result
    };
  });
}

function resetRiskBoard(session){
  session.data.values = [1,3,5,-2,-5].sort(()=>Math.random()-.5);
  session.data.revealed = Object.create(null);
}

function finishRiskIfNeeded(session){
  if(session.round <= GAME_MAX_ROUNDS) return false;
  const a=session.data.bank[session.a], b=session.data.bank[session.b];
  const winner=a===b?null:(a>b?session.a:session.b);
  finishGame(session, winner ? 'Ryzykant zakończony — mamy zwycięzcę.' : 'Ryzykant zakończony — remis.', {scores:{...session.data.bank},winner});
  return true;
}

function handleRisk(socket, session, data) {
  const other = socket.id === session.a ? session.b : session.a;
  if(data.action === 'pick'){
    if(session.data.turn !== socket.id) return gameError(socket,'To nie Twoja tura.');
    const used=session.data.picks[socket.id]||0;
    if(used>=RISK_MAX_PICKS_PER_TURN) return gameError(socket,'Wykorzystałeś już 2 ryzyka w tej turze.');
    const index=Number(data.index);
    if(!Number.isInteger(index)||index<0||index>=session.data.values.length) return;
    const value=session.data.values[index];
    if(value===null||value===undefined) return gameError(socket,'To pole jest już odkryte.');
    session.data.picks[socket.id]=used+1;
    session.data.bank[socket.id]+=value;
    session.data.values[index]=null;
    session.data.revealed[socket.id]={index,value};
    const picksLeft=Math.max(0,RISK_MAX_PICKS_PER_TURN-session.data.picks[socket.id]);
    emitGame(socket.id,{game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[socket.id],opponentScore:session.data.bank[other],scores:{...session.data.bank},myTurn:true,picksUsed:session.data.picks[socket.id],picksLeft,revealed:{index,value},status:value>=0?`+${value} punktów.`:`${value} punktów.`});
    emitGame(other,{game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[other],opponentScore:session.data.bank[socket.id],scores:{...session.data.bank},myTurn:false,picksUsed:session.data.picks[other]||0,picksLeft:Math.max(0,RISK_MAX_PICKS_PER_TURN-(session.data.picks[other]||0)),status:'Partner odkrył pole.'});
    if(session.data.picks[socket.id]>=RISK_MAX_PICKS_PER_TURN){
      session.data.turn=other; session.data.picks[socket.id]=0; session.data.picks[other]=0; session.round++;
      if(finishRiskIfNeeded(session)) return;
      resetRiskBoard(session);
      emitRiskState(session,'Limit 2 ryzyk wykorzystany. Tura partnera.');
    }
    return;
  }
  if(data.action==='continue'||data.action==='stop'){
    if(session.data.turn!==socket.id) return gameError(socket,'To nie Twoja tura.');
    const used=session.data.picks[socket.id]||0;
    if(used<1) return gameError(socket,'Najpierw odkryj pole.');
    if(data.action==='stop'){
      session.data.turn=other; session.data.picks[socket.id]=0; session.data.picks[other]=0; session.round++;
      if(finishRiskIfNeeded(session)) return;
      resetRiskBoard(session); emitRiskState(session,'Zachowujesz punkty. Tura partnera.'); return;
    }
    if(used>=RISK_MAX_PICKS_PER_TURN) return gameError(socket,'Limit ryzyka został wykorzystany.');
    resetRiskBoard(session);
    session.data.revealed = Object.create(null);
    emitRiskState(session,'Nowe zakryte pola — możesz ryzykować dalej.');
  }
}

function handleRps(socket, session, data) {
  if (data.action !== 'choose') return;
  const choice = String(data.choice || '');
  if (!['rock','paper','scissors'].includes(choice)) return;
  if (session.data.choices[socket.id]) return;
  session.data.choices[socket.id] = choice;
  const other = socket.id === session.a ? session.b : session.a;
  if (!session.data.choices[other]) {
    emitGame(socket.id,{game:'rps',sessionId:session.id,active:true,round:session.round,choice:'hidden',score:session.data.score,status:'Twój wybór zapisany. Czekamy na partnera.'});
    return;
  }
  const ca=session.data.choices[session.a], cb=session.data.choices[session.b];
  const win=(x,y)=>x===y?'draw':((x==='rock'&&y==='scissors')||(x==='paper'&&y==='rock')||(x==='scissors'&&y==='paper'))?'a':'b';
  const result=win(ca,cb);
  if(result==='a')session.data.score[session.a]++;
  if(result==='b')session.data.score[session.b]++;
  if(session.round >= 5) return finishGame(session,result==='draw'?'Ostatnia runda: remis.':'Koniec 5 rund.',{choices:{[session.a]:ca,[session.b]:cb},score:session.data.score,round:session.round,winner:result==='draw'?null:(result==='a'?session.a:session.b)});
  emitPair(session,id=>({game:'rps',sessionId:session.id,active:true,round:session.round,choice:id===session.a?ca:cb,reveal:{[session.a]:ca,[session.b]:cb},roundResult:result,score:session.data.score,status:result==='draw'?'Remis rundy.':'Runda zakończona.'}));
  session.round++;
  session.data.choices=Object.create(null);
  setTimeout(()=>{if(!session.active)return;emitPair(session,id=>({game:'rps',sessionId:session.id,active:true,round:session.round,choice:null,score:session.data.score,status:'Wybierz ruch. Wybory są ukryte do czasu decyzji obu osób.'}));},700);
}

function handleGameAction(socket, data) {
  if (!data || typeof data.game !== 'string') return;
  const session = getGameSession(socket.id);
  if (!session) return gameError(socket,'Nie masz aktywnej gry.');
  if (!session.active) return;
  if (data.game !== session.game || !validateGameName(data.game)) return gameError(socket,'Nieprawidłowy stan gry.');
  const action = typeof data.action === 'string' ? data.action : 'unknown';
  if (!allowGameAction(socket.id, data.game, action)) return;
  switch (session.game) {
    case 'drawguess': handleDraw(socket,session,data); break;
    case 'ttt': handleTTT(socket,session,data); break;
    case 'word': handleWord(socket,session,data); break;
    case 'reflex': handleReflex(socket,session,data); break;
    case 'risk': handleRisk(socket,session,data); break;
    case 'rps': handleRps(socket,session,data); break;
    default: gameError(socket,'Nieznana gra.');
  }
}

function stopGameForSocket(socketId, reason='Partner opuścił grę.') {
  const session = gameSessions.get(socketId);
  if (!session) return;
  const partnerId = session.a === socketId ? session.b : session.a;
  clearGameTimeout(session);
  gameSessions.delete(session.a);
  gameSessions.delete(session.b);
  if (isConnected(partnerId)) io.to(partnerId).emit('game:partnerLeft',{game:session.game,message:reason});
}

function handleGameLeave(socket, data) {
  const session = getGameSession(socket.id);
  if (!session) return;
  stopGameForSocket(socket.id, 'Partner zakończył grę.');
  if (isConnected(socket.id)) socket.emit('game:finished',{game:session.game,result:'Wrócono do katalogu gier.'});
}

function handleGameRematch(socket, data) {
  const session = getGameSession(socket.id);
  if (!session || session.active) return;
  gameError(socket,'Ta gra została już zakończona. Wybierz ją ponownie z katalogu.');
}


/* ============================================================
   OCHRONA EVENTÓW SOCKET.IO
============================================================ */

function allowBurst(map, socketId, limit, windowMs) {
  const now = Date.now();
  const old = map.get(socketId) || [];
  const fresh = old.filter(t => now - t < windowMs);
  if (fresh.length >= limit) {
    map.set(socketId, fresh);
    return false;
  }
  fresh.push(now);
  map.set(socketId, fresh);
  return true;
}

function cleanupRateState(socketId) {
  messageRate.delete(socketId);
  reportRate.delete(socketId);
  gameRate.delete(socketId);
  reactionRate.delete(socketId);
  profileRate.delete(socketId);
  chatControlRate.delete(socketId);
}

/* ============================================================
   SOCKET.IO
============================================================ */


io.on(
  'connection',
  socket => {
    console.log(
      'Nowe połączenie użytkownika:',
      socket.id
    );

    emitOnlineCount();

    /* ========================================================
       START CZATU
    ======================================================== */

    socket.on(
      'startChat',
      data => {
        if (!allowBurst(chatControlRate, socket.id, 8, 30_000)) return;
        if (!isConnected(socket.id)) return;
        publicProfiles.set(socket.id, sanitizePublicProfile(data?.profile));

        // START jest idempotentny: kliknięcie ponownie nie tworzy
        // drugiego połączenia ani nie pozwala połączyć użytkownika z samym sobą.
        if (pairs[socket.id]) return;
        if (waitingUsers.includes(socket.id)) return;

        lastPartnerForReport.delete(socket.id);
        reportedThisSession.delete(socket.id);
        photoCounts.set(socket.id, 0);

        matchWaitingUser(socket.id);
      }
    );

    /* ========================================================
       WIADOMOŚCI
    ======================================================== */

    socket.on(
      'sendMessage',
      msg => {
        if (!allowBurst(messageRate, socket.id, 20, 10_000)) {
          socket.emit('messageBlocked', 'Wysyłasz wiadomości zbyt szybko. Odczekaj chwilę.');
          return;
        }

        const partnerId =
          getPartner(
            socket.id
          );

        if (!partnerId) {
          return;
        }

        const rawText =
          typeof msg === 'string'
            ? msg
            : (
                msg &&
                msg.type === 'text'
              )
              ? String(
                  msg.content ||
                  ''
                )
              : '';

        if (
          !rawText.trim()
        ) {
          return;
        }

        if (
          containsBlockedTerm(
            rawText
          )
        ) {
          socket.emit(
            'messageBlocked',
            'Wiadomość zawiera zakazane określenie i nie została wysłana.'
          );

          return;
        }

        const messageId = randomId();
        const payload = {
          type: 'text',
          messageId,
          content: rawText.slice(0, MAX_MESSAGE_LENGTH)
        };
        chatMessageRegistry.set(messageId, {
          a: socket.id,
          b: partnerId,
          createdAt: Date.now()
        });
        io.to(socket.id).emit('receiveMessage', { ...payload, fromSelf:true });
        io.to(partnerId).emit('receiveMessage', { ...payload, fromSelf:false });
      }
    );

    /* ========================================================
       PISANIE NA ŻYWO + REAKCJE
    ======================================================== */

    socket.on('profile:update', data => {
      if(!allowBurst(profileRate, socket.id, 8, 10_000)) return;
      if(!data?.profile) return;
      publicProfiles.set(socket.id, sanitizePublicProfile(data.profile));
      const partnerId=getPartner(socket.id);
      if(partnerId) io.to(partnerId).emit('partnerProfile', publicProfiles.get(socket.id));
    });

    socket.on('typing', active => {
      if(!allowBurst(profileRate, socket.id, 40, 10_000)) return;
      const partnerId = getPartner(socket.id);
      if(!partnerId) return;
      io.to(partnerId).emit('typing', active === true);
    });

    socket.on('reactMessage', data => {
      if(!allowBurst(reactionRate, socket.id, 30, 10_000)) return;
      const partnerId = getPartner(socket.id);
      if(!partnerId || !data || typeof data.messageId !== 'string') return;
      const entry = chatMessageRegistry.get(data.messageId);
      if(!entry || !((entry.a===socket.id && entry.b===partnerId)||(entry.b===socket.id && entry.a===partnerId))) return;
      const allowed = new Set(['❤️','😂','😮','👍','🔥']);
      let reaction = allowed.has(data.reaction) ? data.reaction : '';
      let users = messageReactions.get(data.messageId);
      if(!users){ users=new Map(); messageReactions.set(data.messageId, users); }
      if(reaction && users.get(socket.id) === reaction) reaction='';
      if(reaction) users.set(socket.id, reaction); else users.delete(socket.id);
      const counts = new Map();
      for(const r of users.values()) counts.set(r,(counts.get(r)||0)+1);
      const current = users.get(socket.id) || '';
      const payload={messageId:data.messageId,reaction:current,count:current?(counts.get(current)||1):0,counts:Object.fromEntries(counts),fromSelf:false};
      io.to(socket.id).emit('messageReaction',{...payload,fromSelf:true});
      io.to(partnerId).emit('messageReaction',payload);
    });

    /* ========================================================
       ZDJĘCIE
    ======================================================== */

    socket.on(
      'sendPhoto',
      url => {
        const partnerId =
          getPartner(
            socket.id
          );

        if (!partnerId) {
          return;
        }

        if (
          typeof url !== 'string' ||
          !url.startsWith(
            '/uploads/'
          )
        ) {
          return;
        }

        /*
          Twardy limit:
          1 zdjęcie na użytkownika
          w aktualnej rozmowie.
        */

        const count =
          photoCounts.get(
            socket.id
          ) || 0;

        if (
          count >=
          MAX_PHOTOS_PER_SESSION
        ) {
          socket.emit(
            'photoLimitReached',
            'W tej rozmowie można wysłać maksymalnie 1 zdjęcie.'
          );

          return;
        }

        /*
          Sprawdzamy, czy plik faktycznie
          istnieje na serwerze.
        */

        const encoded =
          url
            .replace(
              '/uploads/',
              ''
            )
            .split('?')[0];

        let filename;

        try {
          filename =
            decodeURIComponent(
              encoded
            );
        } catch {
          return;
        }

        /*
          Ochrona przed path traversal.
        */

        if (
          filename.includes('/') ||
          filename.includes('\\') ||
          filename.includes('..')
        ) {
          return;
        }

        const fullPath =
          path.join(
            uploadFolder,
            filename
          );

        if (
          !fs.existsSync(
            fullPath
          )
        ) {
          return;
        }

        photoCounts.set(
          socket.id,
          count + 1
        );

        io.to(
          partnerId
        ).emit(
          'receiveMessage',
          {
            type: 'photo',
            content:
              '/uploads/' +
              encodeURIComponent(
                filename
              )
          }
        );
      }
    );

    /* ========================================================
       ZGŁOSZENIE PARTNERA
    ======================================================== */

    socket.on(
      'reportUser',
      data => {
        if (!allowBurst(reportRate, socket.id, 3, 60_000)) {
          socket.emit('reportError', 'Zgłoszenia można wysyłać rzadziej. Spróbuj ponownie za chwilę.');
          return;
        }
        const partnerId =
          getPartner(
            socket.id
          ) ||
          lastPartnerForReport.get(
            socket.id
          );

        if (!partnerId) {
          socket.emit(
            'reportError',
            'Nie ma partnera, którego można teraz zgłosić.'
          );

          return;
        }

        if (
          reportedThisSession.has(
            socket.id
          )
        ) {
          socket.emit(
            'reportError',
            'To zgłoszenie zostało już wysłane.'
          );

          return;
        }

        const allowedReasons =
          new Set([
            'spam',
            'wulgarny',
            'erotyczne',
            'nękanie',
            'grozby',
            'inne'
          ]);

        const reason =
          allowedReasons.has(
            data?.reason
          )
            ? data.reason
            : 'inne';

        const details =
          typeof data?.details ===
          'string'
            ? data.details
                .trim()
                .slice(
                  0,
                  MAX_REPORT_DETAILS
                )
            : '';

        const report = {
          id:
            `${Date.now()}-${randomId()}`,

          createdAt:
            new Date().toISOString(),

          reason,

          details,

          reporterSocketId:
            socket.id,

          reportedSocketId:
            partnerId
        };

        saveReport(
          report
        );

        reportedThisSession.add(
          socket.id
        );

        console.log(
          `Zgłoszenie: ${socket.id} zgłosił ${partnerId} — ${reason}`
        );

        socket.emit(
          'reportAccepted'
        );
      }
    );

    /* ========================================================
       START ZAPROSZENIA DO GRY
    ======================================================== */

    socket.on(
      'game:invite',
      data => {
        if (!data) {
          return;
        }

        sendInvite(
          socket,
          data.game
        );
      }
    );

    /* ========================================================
       AKCEPTACJA / ODRZUCENIE GRY
    ======================================================== */

    socket.on(
      'game:inviteResponse',
      data => {
        handleInviteResponse(
          socket,
          data
        );
      }
    );

    /* ========================================================
       AKCJE GIER
    ======================================================== */

    socket.on(
      'game:action',
      data => {
        handleGameAction(
          socket,
          data
        );
      }
    );

    socket.on(
      'game:leave',
      data => handleGameLeave(socket, data)
    );

    socket.on(
      'game:rematch',
      data => handleGameRematch(socket, data)
    );

    /* ========================================================
       STOP CZATU
    ======================================================== */

    socket.on(
      'stopChat',
      () => {
        if (!allowBurst(chatControlRate, socket.id, 12, 30_000)) return;
        if (
          !pairs[socket.id] &&
          !waitingUsers.includes(
            socket.id
          )
        ) {
          return;
        }

        photoCounts.delete(
          socket.id
        );

        console.log(
          `${socket.id} kończy czat.`
        );

        breakPair(
          socket.id,
          true
        );

        emitOnlineCount();
      }
    );

    /* ========================================================
       ROZŁĄCZENIE
    ======================================================== */

    socket.on(
      'disconnect',
      () => {
        console.log(
          'Użytkownik opuścił czat:',
          socket.id
        );

        reportedThisSession.delete(
          socket.id
        );

        photoCounts.delete(
          socket.id
        );

        lastPartnerForReport.delete(
          socket.id
        );

        clearInviteForPair(
          socket.id
        );

        cleanupRateState(
          socket.id
        );

        breakPair(
          socket.id,
          true
        );

        removeFromWaiting(
          socket.id
        );

        emitOnlineCount();
      }
    );
  }
);

/* ============================================================
   AUTOMATYCZNE CZYSZCZENIE MARTWEJ KOLEJKI
============================================================ */

setInterval(
  () => {
    waitingUsers =
      waitingUsers.filter(
        socketId =>
          isConnected(
            socketId
          ) &&
          !pairs[socketId]
      );
  },
  5 * 1000
);

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of gameRate) {
    if (now - timestamp > 60_000) gameRate.delete(key);
  }
  for (const [id, times] of messageRate) {
    const fresh = times.filter(t => now - t < 10_000);
    if (fresh.length) messageRate.set(id, fresh); else messageRate.delete(id);
  }
  for (const [id, times] of reportRate) {
    const fresh = times.filter(t => now - t < 60_000);
    if (fresh.length) reportRate.set(id, fresh); else reportRate.delete(id);
  }
  for (const [id, times] of reactionRate) {
    const fresh = times.filter(t => now - t < 10_000);
    if (fresh.length) reactionRate.set(id, fresh); else reactionRate.delete(id);
  }
  for (const [id, times] of profileRate) {
    const fresh = times.filter(t => now - t < 10_000);
    if (fresh.length) profileRate.set(id, fresh); else profileRate.delete(id);
  }
  for (const [id, times] of uploadRate) {
    const fresh = times.filter(t => now - t < 60_000);
    if (fresh.length) uploadRate.set(id, fresh); else uploadRate.delete(id);
  }
}, 60_000);

/* ============================================================
   AUTOMATYCZNE CZYSZCZENIE STARYCH INVITE
============================================================ */

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [socketId, invite]
      of pendingInvites.entries()
    ) {
      if (
        now -
          invite.createdAt >
        GAME_INVITE_TIMEOUT + 5000
      ) {
        clearInviteForPair(
          socketId
        );
      }
    }
  },
  10 * 1000
);

setInterval(() => {
  const cutoff=Date.now()-15*60_000;
  for(const [id,e] of chatMessageRegistry){if(e.createdAt<cutoff){chatMessageRegistry.delete(id);messageReactions.delete(id);}}
},60_000);

/* ============================================================
   START SERWERA
============================================================ */

server.listen(
  PORT,
  () => {
    console.log(
      `Czatuj24 działa na porcie ${PORT}`
    );

    console.log(
      `Limit zdjęć na rozmowę: ${MAX_PHOTOS_PER_SESSION}`
    );

    console.log(
      `Dostępne gry: ${Object.keys(GAME_NAMES).join(', ')}`
    );
  }
);
process.on('uncaughtException', err => {
  console.error('Nieobsłużony wyjątek serwera:', err);
});

process.on('unhandledRejection', reason => {
  console.error('Nieobsłużone odrzucenie Promise:', reason);
});
