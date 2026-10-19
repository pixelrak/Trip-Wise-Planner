import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter, Link } from 'wouter';
import { ArrowDownUp, ArrowRight, BookmarkPlus, Check, ExternalLink, MapPin, Search, X } from 'lucide-react';

type Destination = {
  id: string;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  city: string;
  address: string;
  description?: string;
  image?: string;
  openingHours?: string;
  website?: string;
  source: string;
  wikipedia?: string;
};
type TripItem = Destination & { day: number | null };
type OsmElement = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
type WikiNearbyPage = { pageid: number; title: string; lat: number; lon: number; dist: number };
type WikiArticle = { pageid: number; title: string; fullurl?: string; extract?: string; thumbnail?: { source: string }; categories?: { title: string }[] };
const queryClient = new QueryClient();
const STORAGE_KEY = 'trip-wise-itinerary-v1';
const CATEGORIES = ['All places', 'Attractions', 'Museums', 'Historic', 'Parks & gardens', 'Galleries', 'Landmarks'];

function categoryOf(tags: Record<string, string>) {
  if (tags.tourism === 'museum' || tags.tourism === 'gallery') return tags.tourism === 'museum' ? 'Museums' : 'Galleries';
  if (tags.leisure === 'park' || tags.leisure === 'garden') return 'Parks & gardens';
  if (tags.historic) return 'Historic';
  if (tags.tourism === 'attraction') return 'Attractions';
  if (tags.amenity === 'arts_centre') return 'Galleries';
  return 'Landmarks';
}
function displayName(tags: Record<string, string>) {
  return tags.name || tags['name:en'] || tags.official_name || tags.short_name || '';
}
function areaFromAddress(tags: Record<string, string>, city: string) {
  return tags['addr:city'] || tags['addr:suburb'] || tags['addr:district'] || city;
}
function formatAddress(tags: Record<string, string>, city: string) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return [street, tags['addr:suburb'] || tags['addr:district'], tags['addr:city'] || city, tags['addr:postcode']].filter(Boolean).join(', ') || `${city}, see map`;
}
function wikipediaTitle(value?: string) {
  if (!value) return null;
  const split = value.indexOf(':');
  if (split < 0) return { lang: 'en', title: value.replaceAll(' ', '_') };
  return { lang: value.slice(0, split), title: value.slice(split + 1).replaceAll(' ', '_') };
}
function fromOsm(element: OsmElement, city: string): Destination | null {
  const tags = element.tags || {};
  const name = displayName(tags);
  const coordinates = element.center || (element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : null);
  if (!name || !coordinates) return null;
  const wiki = wikipediaTitle(tags.wikipedia);
  const wikidata = tags.wikidata;
  return {
    id: `${element.type}/${element.id}`, name, category: categoryOf(tags), latitude: coordinates.lat, longitude: coordinates.lon,
    city: areaFromAddress(tags, city), address: formatAddress(tags, city),
    openingHours: tags.opening_hours, website: tags.website || tags['contact:website'],
    source: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    wikipedia: wiki ? `https://${wiki.lang}.wikipedia.org/wiki/${wiki.title}` : wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : undefined,
  };
}
function categoryFromWikipedia(title: string, detail: WikiArticle) {
  const words = `${title} ${(detail.categories || []).map(item => item.title).join(' ')} ${detail.extract || ''}`.toLowerCase();
  if (/\b(museum|musée)\b/.test(words)) return 'Museums';
  if (/\b(gallery|galleries|galerie|arts centre|art museum)\b/.test(words)) return 'Galleries';
  if (/\b(park|garden|jardin|parc)\b/.test(words)) return 'Parks & gardens';
  if (/\b(historic|heritage|church|cathedral|chapel|basilica|temple|mosque|synagogue|abbey|monument|memorial|castle|palace|château)\b/.test(words)) return 'Historic';
  if (/\b(landmark|tower|bridge|square|plaza|arch|obelisk|statue|fountain|island|port|avenue|street|rue|pont|place|fontaine)\b/.test(words)) return 'Landmarks';
  return 'Attractions';
}
async function findNearbyWikipediaPlaces(latitude: number, longitude: number, city: string): Promise<Destination[]> {
  const geoUrl = new URL('https://en.wikipedia.org/w/api.php');
  Object.entries({
    action: 'query', list: 'geosearch', gscoord: `${latitude}|${longitude}`, gsradius: '10000',
    gslimit: '50', format: 'json', origin: '*',
  }).forEach(([key, value]) => geoUrl.searchParams.set(key, value));
  const geoResponse = await fetch(geoUrl);
  if (!geoResponse.ok) throw new Error('The nearby article directory is unavailable.');
  const geoData = await geoResponse.json();
  const excludedTitle = /\b(siege|battle|commune|empire|timeline|festival|attack|bombing|war|massacre|opening ceremony|fires? in|history of|election)\b/i;
  const likelyPlace = /\b(museum|musée|gallery|galerie|park|parc|garden|jardin|church|église|cathedral|cathédrale|chapel|chapelle|basilica|temple|mosque|synagogue|abbey|monument|memorial|castle|palace|palais|tower|tour|bridge|pont|square|plaza|arch|statue|fountain|fontaine|island|port|avenue|street|rue|place|station|hotel|hôtel|hall|market|theatre|theater|opera|opéra|library|mairie|house|cemetery|cimetière|quai|louvre|eiffel|notre.?dame|bastille|acropolis|cafe|café|department store)\b/i;
  const nearby = (geoData.query?.geosearch || []) as WikiNearbyPage[];
  const candidates = nearby.filter(page =>
    page.dist > 60 &&
    !excludedTitle.test(page.title) &&
    page.title.toLowerCase() !== city.split(',')[0].trim().toLowerCase() &&
    likelyPlace.test(page.title),
  ).slice(0, 50);
  if (!candidates.length) return [];

  const detailUrl = new URL('https://en.wikipedia.org/w/api.php');
  Object.entries({
    action: 'query', prop: 'pageimages|extracts|categories|info',
    pageids: candidates.map(page => page.pageid).join('|'), exintro: '1', explaintext: '1',
    cllimit: '20', inprop: 'url', pithumbsize: '1000', format: 'json', origin: '*',
  }).forEach(([key, value]) => detailUrl.searchParams.set(key, value));
  const detailResponse = await fetch(detailUrl);
  if (!detailResponse.ok) throw new Error('Nearby destination details are unavailable.');
  const detailData = await detailResponse.json();
  const details = Object.values((detailData.query?.pages || {}) as Record<string, WikiArticle>);
  const byId = new Map(details.map(page => [page.pageid, page]));
  return candidates.map(page => {
    const detail = byId.get(page.pageid);
    const source = detail?.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`;
    return {
      id: `wikipedia/${page.pageid}`,
      name: page.title,
      category: categoryFromWikipedia(page.title, detail || { pageid: page.pageid, title: page.title }),
      latitude: page.lat,
      longitude: page.lon,
      city,
      address: `Near ${city} · approximate location`,
      description: detail?.extract?.replace(/\s+/g, ' ').trim().slice(0, 440),
      image: detail?.thumbnail?.source,
      source,
      wikipedia: source,
    };
  });
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch>
    <Route path="/"><Discovery /></Route>
    <Route path="/trip"><Trip /></Route>
    <Route component={NotFound} />
  </Switch></ErrorBoundary>;
}

function useTrip() {
  const [trip, setTrip] = useState<TripItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as TripItem[]; } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(trip)); }, [trip]);
  const add = (destination: Destination) => setTrip(current => current.some(item => item.id === destination.id) ? current : [...current, { ...destination, day: null }]);
  const remove = (id: string) => setTrip(current => current.filter(item => item.id !== id));
  const assign = (id: string, day: number | null) => setTrip(current => current.map(item => item.id === id ? { ...item, day } : item));
  return { trip, add, remove, assign };
}
function Shell({ children, count }: { children: ReactNode; count: number }) {
  const [location] = useLocation();
  return <>
    <div className="app-shell">
      <header className="topbar">
        <Link href="/" className="brand" data-testid="link-brand">trip<span>wise</span></Link>
        <nav className="nav-links" aria-label="Main navigation">
          <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-explore">Explore</Link>
          <Link href="/trip" className={`nav-link ${location === '/trip' ? 'active' : ''}`} data-testid="link-my-trip">My Trip<span className="trip-count">{count || ''}</span></Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="attribution">Place data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> and <a href="https://www.wikipedia.org/" target="_blank" rel="noreferrer">Wikipedia</a> · see each destination for its source</footer>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <Link href="/" className={location === '/' ? 'active' : ''} data-testid="mobile-link-explore"><Search size={16} />Explore</Link>
      <Link href="/trip" className={location === '/trip' ? 'active' : ''} data-testid="mobile-link-trip"><BookmarkPlus size={16} />My Trip{count ? ` · ${count}` : ''}</Link>
    </nav>
  </>;
}
function Discovery() {
  const { trip, add } = useTrip();
  const [cityInput, setCityInput] = useState('Paris, France');
  const [city, setCity] = useState('Paris, France');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All places');
  const [sort, setSort] = useState('featured');
  const [places, setPlaces] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sourceNotice, setSourceNotice] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Destination | null>(null);
  const latestRequest = useRef(0);

  const discover = async (location: string, req = latestRequest.current + 1) => {
    latestRequest.current = req;
    setLoading(true); setError(''); setSourceNotice(''); setPlaces([]); setCity(location);
    try {
      const geoResponse = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`, { headers: { Accept: 'application/json' } });
      if (!geoResponse.ok) throw new Error('Location search is temporarily unavailable.');
      const geo = await geoResponse.json();
      if (!geo.length) throw new Error(`We couldn’t find “${location}”. Try a city, region, or landmark.`);
      const { lat, lon, display_name } = geo[0];
      const cityLabel = (display_name as string).split(',').slice(0, 2).join(',').trim() || location;
      setCity(cityLabel); setCityInput(location);
      let found: Destination[] = [];
      let usedWikipediaFallback = false;
      try {
        const query = `[out:json][timeout:25];(nwr(around:5000,${lat},${lon})[tourism~"^(attraction|museum|gallery|artwork|viewpoint|zoo|aquarium)$"][name];nwr(around:5000,${lat},${lon})[historic][name];nwr(around:5000,${lat},${lon})[leisure~"^(park|garden)$"][name];);out center;`;
        const response = await fetch('https://overpass.kumi.systems/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: `data=${encodeURIComponent(query)}` });
        if (!response.ok) throw new Error('The OpenStreetMap place directory is unavailable.');
        const result = await response.json();
        const deduped = new Map<string, Destination>();
        (result.elements as OsmElement[]).forEach(el => { const place = fromOsm(el, cityLabel); if (place) deduped.set(place.id, place); });
        found = [...deduped.values()];
        if (!found.length) throw new Error('No named places were returned.');
      } catch {
        found = await findNearbyWikipediaPlaces(Number(lat), Number(lon), cityLabel);
        usedWikipediaFallback = true;
      }
      if (req !== latestRequest.current) return;
      setPlaces(found);
      if (!found.length) setError(`No named places surfaced around ${cityLabel}. Try another location.`);
      if (usedWikipediaFallback && found.length) setSourceNotice('OpenStreetMap places are temporarily unavailable. Showing nearby Wikipedia entries instead.');
      setLoading(false);
      if (usedWikipediaFallback) return;
      // Enrich only entries with a Wikipedia tag; individual failures remain optional.
      void Promise.all(found.filter(place => place.wikipedia).slice(0, 50).map(async place => {
        try {
          let description: string | undefined;
          let image: string | undefined;
          if (place.wikipedia!.includes('wikipedia.org/wiki/')) {
            const title = decodeURIComponent(place.wikipedia!.split('/wiki/')[1]).replaceAll('_', ' ');
            const language = new URL(place.wikipedia!).hostname.split('.')[0];
            const summaryRes = await fetch(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
            if (summaryRes.ok) {
              const summary = await summaryRes.json();
              description = summary.extract;
              image = summary.thumbnail?.source;
            }
          } else {
            const entityId = place.wikipedia!.split('/').pop();
            const entityRes = entityId ? await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`) : null;
            if (entityRes?.ok && entityId) {
              const entity = await entityRes.json();
              const record = entity.entities?.[entityId];
              description = record?.descriptions?.en?.value;
              const filename = record?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
              if (filename) image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=1000`;
            }
          }
          if (description || image) setPlaces(current => current.map(item => item.id === place.id ? { ...item, description: description || item.description, image: image || item.image } : item));
        } catch { /* Optional Wikipedia data; keep the OSM record intact. */ }
      }));
    } catch (reason) {
      if (req !== latestRequest.current) return;
      setError(reason instanceof TypeError ? 'We couldn’t connect to the public place services. Check your connection and try again.' : reason instanceof Error ? reason.message : 'We couldn’t reach the public place directory. Please try again.');
      setLoading(false);
    }
  };
  useEffect(() => { void discover('Paris, France', 1); }, []);
  const visible = useMemo(() => places.filter(place => (filter === 'All places' || place.category === filter) && `${place.name} ${place.description || ''} ${place.category} ${place.city} ${place.address}`.toLowerCase().includes(search.toLowerCase())).sort((a,b) => sort === 'az' ? a.name.localeCompare(b.name) : 0), [places, filter, search, sort]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (cityInput.trim()) void discover(cityInput.trim()); };
  const onAdd = (place: Destination) => {
    const duplicate = trip.some(item => item.id === place.id);
    add(place); setNotice(duplicate ? 'Already in your trip.' : 'Added to your trip.'); window.setTimeout(() => setNotice(''), 2200);
  };
  return <Shell count={trip.length}>
    <section className="hero">
      <div className="hero-copy"><div className="eyebrow">A field guide for the curious</div><h1>Find a place<br />to <em>remember.</em></h1><p>Thoughtful corners, storied buildings and green escapes — gathered from the open map, ready for your own itinerary.</p></div>
      <div className="hero-index">01<small>Discover</small></div>
    </section>
    <form className="search-panel" onSubmit={submit}>
      <label><span className="field-label">Where are you headed?</span><input className="line-input" aria-label="City or location" data-testid="input-location" value={cityInput} onChange={event => setCityInput(event.target.value)} placeholder="City, region or landmark" /></label>
      <label><span className="field-label">Search within these places</span><input className="line-input" aria-label="Search results" data-testid="input-place-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Try a name, neighborhood or type" /></label>
      <div className="search-actions"><button type="submit" className="button" data-testid="button-find-places" disabled={loading}><Search size={14} />{loading ? 'Finding…' : 'Find places'}</button><button type="button" className="button secondary" data-testid="button-use-city" onClick={() => { setCityInput(''); document.querySelector<HTMLInputElement>('[data-testid="input-location"]')?.focus(); }} aria-label="Clear location"><ArrowRight size={15} /></button></div>
    </form>
    <div className="filter-row" aria-label="Filter categories"><span className="filter-label">Browse by</span>{CATEGORIES.map(category => <button key={category} className={`filter-btn ${filter === category ? 'selected' : ''}`} onClick={() => setFilter(category)} data-testid={`filter-${category.toLowerCase().replaceAll(/[^a-z]+/g,'-')}`}>{category}</button>)}</div>
    <div className="results-meta"><span data-testid="text-result-count">{loading ? `Looking around ${city}…` : `${visible.length} ${visible.length === 1 ? 'place' : 'places'} around ${city}`}</span><label><ArrowDownUp size={12} style={{ verticalAlign:'middle', marginRight:6 }} /><select aria-label="Sort places" data-testid="select-sort" value={sort} onChange={event => setSort(event.target.value)}><option value="featured">Nearby order</option><option value="az">A to Z</option></select></label></div>
    {sourceNotice && <div className="source-notice" role="status" data-testid="status-fallback-source">{sourceNotice}</div>}
    {loading ? <div className="place-grid" data-testid="loading-places">{Array.from({length:6},(_,i)=><div key={i} className="place-card"><div className="image-wrap skeleton" /><div className="place-info"><div className="skeleton" style={{height:9,width:'32%',marginBottom:10}}/><div className="skeleton" style={{height:20,width:'75%',marginBottom:9}}/><div className="skeleton" style={{height:11,width:'52%'}}/></div></div>)}</div>
      : error ? <div className="status-panel" data-testid="status-error"><div className="eyebrow">A small detour</div><h2 className="status-title">We couldn’t find the way.</h2><p className="status-copy">{error}</p><button className="button secondary" onClick={() => void discover(cityInput || city)} data-testid="button-retry">Try again</button></div>
      : visible.length ? <div className="place-grid" data-testid="place-grid">{visible.map((place, index)=><article className="place-card" key={place.id} role="button" tabIndex={0} onClick={() => setSelected(place)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelected(place); }} data-testid={`card-place-${place.id.replace('/','-')}`}><div className="image-wrap">{place.image ? <img className="place-image" src={place.image} alt="" loading="lazy" /> : <div className="image-placeholder"><MapPin size={18} strokeWidth={1} /></div>}<span className="card-number">{String(index + 1).padStart(2,'0')}</span></div><div className="place-info"><div className="place-category">{place.category}</div><h2 className="place-name">{place.name}</h2><div className="place-location">{place.city}</div></div></article>)}</div>
      : <div className="status-panel" data-testid="status-empty"><div className="eyebrow">A quieter corner</div><h2 className="status-title">Nothing by that name, yet.</h2><p className="status-copy">Try another search or choose a different category.</p><button className="button secondary" onClick={() => { setSearch(''); setFilter('All places'); }} data-testid="button-clear-filters">Clear filters</button></div>}
    {selected && <DetailModal place={selected} saved={trip.some(item => item.id === selected.id)} onAdd={() => onAdd(selected)} onClose={() => setSelected(null)} />}
    {notice && <div className="toast-message" role="status" data-testid="status-trip-notice">{notice}</div>}
  </Shell>;
}

function DetailModal({ place, saved, onAdd, onClose }: { place: Destination; saved: boolean; onAdd: () => void; onClose: () => void }) {
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle); }, [onClose]);
  const [address, setAddress] = useState(place.address);
  const [addressLoading, setAddressLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setAddress(place.address);
    if (!place.address.includes('approximate location')) {
      setAddressLoading(false);
      return () => { active = false; };
    }
    setAddressLoading(true);
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({ format: 'jsonv2', lat: String(place.latitude), lon: String(place.longitude), addressdetails: '1' }).toString();
    void fetch(url, { headers: { Accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) throw new Error('Reverse geocoding unavailable');
        return response.json() as Promise<{ display_name?: string }>;
      })
      .then(result => { if (active && result.display_name) setAddress(result.display_name); })
      .catch(() => {})
      .finally(() => { if (active) setAddressLoading(false); });
    return () => { active = false; };
  }, [place]);
  const wikiSource = place.id.startsWith('wikipedia/');
  const mapUrl = `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=18/${place.latitude}/${place.longitude}`;
  return <div className="modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }} data-testid="modal-place-details">
    <section className="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <button className="modal-close" onClick={onClose} aria-label="Close details" data-testid="button-close-details"><X size={18} /></button>
      {place.image ? <img className="modal-image" src={place.image} alt={place.name} /> : <div className="modal-image image-placeholder"><MapPin size={24} /></div>}
      <div className="modal-content">
        <div className="eyebrow">{place.category} · {place.city}</div>
        <h2 id="detail-title">{place.name}</h2>
        <div className="modal-address" data-testid="text-place-address">{addressLoading ? 'Finding the nearest address…' : address}</div>
        {place.description && <p className="modal-description">{place.description}</p>}
        {place.openingHours && <p className="modal-address"><strong>Opening hours</strong><br />{place.openingHours}</p>}
        <div className="detail-links">
          {place.website && <a href={place.website} target="_blank" rel="noreferrer" data-testid="link-place-website">Website <ExternalLink size={12} /></a>}
          <a href={mapUrl} target="_blank" rel="noreferrer" data-testid="link-place-map">Open map <ExternalLink size={12} /></a>
          <a href={place.source} target="_blank" rel="noreferrer" data-testid="link-place-source">{wikiSource ? 'Wikipedia article' : 'OpenStreetMap record'} <ExternalLink size={12} /></a>
          {!wikiSource && place.wikipedia && <a href={place.wikipedia} target="_blank" rel="noreferrer" data-testid="link-place-wikipedia">Wikipedia <ExternalLink size={12} /></a>}
        </div>
        <button className="button" onClick={onAdd} data-testid="button-add-to-trip">{saved ? <Check size={15} /> : <BookmarkPlus size={15} />}{saved ? 'In your trip' : 'Add to my trip'}</button>
      </div>
    </section>
  </div>;
}

function Trip() {
  const { trip, remove, assign } = useTrip();
  const [days, setDays] = useState(3);
  const [confirmId, setConfirmId] = useState('');
  const scheduled = useMemo(() => trip.filter(item => item.day !== null).sort((a,b) => (a.day || 0) - (b.day || 0) || a.name.localeCompare(b.name)), [trip]);
  const unscheduled = useMemo(() => trip.filter(item => item.day === null), [trip]);
  const dayNumbers = useMemo(() => Array.from({length:Math.max(days, ...trip.map(item => item.day || 0), 1)},(_,i)=>i+1), [days,trip]);
  const groups = useMemo(() => dayNumbers.map(day => ({ day, places: scheduled.filter(item => item.day === day) })), [dayNumbers,scheduled]);
  return <Shell count={trip.length}>
    <section className="trip-heading"><div className="eyebrow">Your field notes · {trip.length} {trip.length === 1 ? 'place' : 'places'}</div><h1>My <em style={{color:'#747f57'}}>Trip.</em></h1><p>A loose plan is still a plan. Arrange your finds by day, or leave a place for later.</p></section>
    <div className="trip-controls"><label className="field-label" htmlFor="trip-days">Trip length</label><select id="trip-days" className="day-count" value={days} onChange={event => setDays(Number(event.target.value))} data-testid="select-trip-length">{Array.from({length:14},(_,i)=><option key={i+1} value={i+1}>{i+1} {i===0?'day':'days'}</option>)}</select></div>
    {trip.length === 0 ? <div className="status-panel trip-empty" data-testid="status-trip-empty"><div className="eyebrow">The first page is blank</div><h2 className="status-title">Your trip begins with a place.</h2><p className="status-copy">Explore the map and save somewhere you’d like to remember.</p><Link href="/" className="button" data-testid="link-discover-places">Explore places <ArrowRight size={14} /></Link></div> :
      <div className="itinerary" data-testid="itinerary">
        {groups.map(({day,places})=><section className={`day-section ${places.length ? '' : 'day-empty'}`} key={day} data-testid={`section-day-${day}`}><div className="day-title"><span className="day-number">0{day}</span><h2>Day {day}</h2><span className="day-rule" /><span className="day-count">{places.length} {places.length===1?'place':'places'}</span></div>{places.length ? <div className="trip-list">{places.map(item=><TripRow item={item} dayNumbers={dayNumbers} assign={assign} remove={remove} confirmId={confirmId} setConfirmId={setConfirmId} key={item.id} />)}</div> : <p className="day-hint">Leave room for a discovery.</p>}</section>)}
        <section className="day-section unscheduled-section" data-testid="section-unscheduled"><div className="day-title"><span className="day-number">—</span><h2>Unscheduled</h2><span className="day-rule" /><span className="day-count">{unscheduled.length} {unscheduled.length===1?'place':'places'}</span></div>{unscheduled.length ? <div className="trip-list">{unscheduled.map(item=><TripRow item={item} dayNumbers={dayNumbers} assign={assign} remove={remove} confirmId={confirmId} setConfirmId={setConfirmId} key={item.id} />)}</div> : <p className="day-hint">All your places have a day.</p>}</section>
      </div>}
  </Shell>;
}
function TripRow({ item, dayNumbers, assign, remove, confirmId, setConfirmId }: { item: TripItem; dayNumbers: number[]; assign: (id: string, day: number | null) => void; remove: (id: string) => void; confirmId: string; setConfirmId: (id: string) => void }) {
  return <article className="trip-row" data-testid={`trip-item-${item.id.replace('/','-')}`}><span className="trip-row-index"><MapPin size={15} strokeWidth={1.5} /></span>{item.image ? <img className="trip-thumb" src={item.image} alt="" loading="lazy" /> : <div className="trip-thumb image-placeholder"><MapPin size={18} /></div>}<div className="trip-copy"><h3>{item.name}</h3><p>{item.category} · {item.city}</p><label className="assign-label">Plan for <select value={item.day ?? ''} aria-label={`Assign ${item.name} to a day`} data-testid={`select-day-${item.id.replace('/','-')}`} onChange={event => assign(item.id, event.target.value ? Number(event.target.value) : null)}><option value="">Unscheduled</option>{dayNumbers.map(day=><option value={day} key={day}>Day {day}</option>)}</select></label></div><div className="row-actions">{confirmId === item.id ? <><button className="remove-btn confirm-remove" onClick={() => { remove(item.id); setConfirmId(''); }} data-testid={`button-confirm-remove-${item.id.replace('/','-')}`}>Confirm</button><button className="remove-btn" onClick={() => setConfirmId('')} data-testid={`button-cancel-remove-${item.id.replace('/','-')}`}>Keep</button></> : <button className="remove-btn" onClick={() => setConfirmId(item.id)} data-testid={`button-remove-${item.id.replace('/','-')}`}>Remove</button>}</div></article>;
}

export default App;
