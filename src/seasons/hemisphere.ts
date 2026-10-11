/**
 * A5.9 The user's hemisphere for seasonal themes (docs/03 §10: "October = autumn" is not
 * universal). Pure. The user's own choice first; otherwise their time zone; otherwise north.
 */

export type Hemisphere = 'north' | 'south';
export type HemisphereSource = 'set' | 'time_zone' | 'default';

/** IANA zones south of the equator, by area, then single zones. */
const SOUTHERN_AREAS = ['Australia/', 'Antarctica/', 'America/Argentina/'];
const SOUTHERN_ZONES = new Set([
  // Oceania and the southern Pacific.
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Fiji',
  'Pacific/Tongatapu',
  'Pacific/Apia',
  'Pacific/Noumea',
  'Pacific/Efate',
  'Pacific/Norfolk',
  'Pacific/Port_Moresby',
  'Pacific/Rarotonga',
  'Pacific/Tahiti',
  'Pacific/Easter',
  // Southern South America.
  'America/Buenos_Aires',
  'America/Santiago',
  'America/Punta_Arenas',
  'America/Montevideo',
  'America/Asuncion',
  'America/La_Paz',
  'America/Lima',
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Recife',
  'America/Fortaleza',
  'America/Maceio',
  'America/Belem',
  'America/Araguaina',
  'America/Campo_Grande',
  'America/Cuiaba',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Manaus',
  'America/Noronha',
  'Atlantic/Stanley',
  'Atlantic/South_Georgia',
  'Atlantic/St_Helena',
  // Southern Africa and the southern Indian Ocean.
  'Africa/Johannesburg',
  'Africa/Maputo',
  'Africa/Harare',
  'Africa/Lusaka',
  'Africa/Windhoek',
  'Africa/Gaborone',
  'Africa/Maseru',
  'Africa/Mbabane',
  'Africa/Blantyre',
  'Africa/Lubumbashi',
  'Africa/Luanda',
  'Africa/Dar_es_Salaam',
  'Indian/Antananarivo',
  'Indian/Mauritius',
  'Indian/Reunion',
  'Indian/Mayotte',
  'Indian/Comoro',
  // Southern Southeast Asia.
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
  'Asia/Dili',
]);

export function hemisphereFor(
  chosen: Hemisphere | null,
  timeZone: string | null,
): { hemisphere: Hemisphere; source: HemisphereSource } {
  if (chosen) return { hemisphere: chosen, source: 'set' };
  if (!timeZone) return { hemisphere: 'north', source: 'default' };
  const south =
    SOUTHERN_ZONES.has(timeZone) || SOUTHERN_AREAS.some((area) => timeZone.startsWith(area));
  return { hemisphere: south ? 'south' : 'north', source: 'time_zone' };
}
