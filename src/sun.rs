use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// Describes why sunrise/sunset cannot be computed at extreme latitudes.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PolarCondition {
    /// The sun never rises above the horizon (winter at high latitudes).
    PolarNight,
    /// The sun never sets below the horizon (summer at high latitudes).
    PolarDay,
}

/// Convert a calendar date to Julian Day Number.
///
/// Uses the algorithm from Meeus, *Astronomical Algorithms* (2nd ed.), Ch. 7.
fn julian_day(year: i32, month: u32, day: u32) -> f64 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = if month <= 2 { month + 12 } else { month };
    let a = (y as f64 / 100.0).floor();
    let b = 2.0 - a + (a / 4.0).floor();
    (365.25 * (y as f64 + 4716.0)).floor() + (30.6001 * (m as f64 + 1.0)).floor() + day as f64 + b
        - 1524.5
}

/// Compute the solar declination (degrees) and Equation of Time (minutes)
/// for a given Julian Day.
///
/// Based on the NOAA Solar Calculations spreadsheet.
fn solar_declination_and_eqtime(jd: f64) -> (f64, f64) {
    let n = jd - 2451545.0;

    // Mean longitude of the Sun, corrected for aberration
    let l = (280.460 + 0.9856474 * n) % 360.0;
    // Mean anomaly
    let g = (357.528 + 0.9856003 * n) % 360.0;

    // Convert to radians
    let l_rad = l.to_radians();
    let g_rad = g.to_radians();

    // Ecliptic longitude
    let lambda = l + 1.915 * g_rad.sin() + 0.020 * (2.0 * g_rad).sin();
    let lambda_rad = lambda.to_radians();

    // Obliquity of the ecliptic
    let epsilon = (23.439 - 0.0000004 * n).to_radians();

    // Declination
    let sin_dec = epsilon.sin() * lambda_rad.sin();
    let dec = sin_dec.asin().to_degrees();

    // Equation of time (minutes)
    let eccentricity = 0.016708634;
    let y = (epsilon / 2.0).tan().powi(2);
    let eq_time = 4.0
        * (y * (2.0 * l_rad).sin() - 2.0 * eccentricity * g_rad.sin()
            + 4.0 * eccentricity * y * g_rad.sin() * (2.0 * l_rad).cos()
            - 0.5 * y * y * (4.0 * l_rad).sin()
            - 1.25 * eccentricity * eccentricity * (2.0 * g_rad).sin())
        .to_degrees();

    (dec, eq_time)
}

/// Compute the hour angle for a given latitude, solar declination, and zenith angle.
///
/// Returns `Ok(angle)` on success, or `Err(PolarCondition)` when the sun
/// never reaches the requested elevation.
fn hour_angle(lat: f64, dec: f64, zenith: f64) -> Result<f64, PolarCondition> {
    let lat_rad = lat.to_radians();
    let dec_rad = dec.to_radians();
    let zen_rad = zenith.to_radians();

    let cos_ha = (zen_rad.cos() - lat_rad.sin() * dec_rad.sin()) / (lat_rad.cos() * dec_rad.cos());

    if cos_ha > 1.0 {
        Err(PolarCondition::PolarNight)
    } else if cos_ha < -1.0 {
        Err(PolarCondition::PolarDay)
    } else {
        Ok(cos_ha.acos().to_degrees())
    }
}

/// Convert a total-minutes-since-midnight value into a UTC timestamp string
/// for the given date.
fn minutes_to_utc(date: NaiveDate, total_minutes: f64) -> String {
    let total_seconds = (total_minutes * 60.0).round() as i64;
    let dt = date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always a valid time")
        + Duration::seconds(total_seconds);
    dt.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SunTimes {
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
    pub solar_noon: String,
    pub day_length: Option<f64>, // seconds
    pub civil_twilight_begin: Option<String>,
    pub civil_twilight_end: Option<String>,
    pub nautical_twilight_begin: Option<String>,
    pub nautical_twilight_end: Option<String>,
    pub astronomical_twilight_begin: Option<String>,
    pub astronomical_twilight_end: Option<String>,
    /// `None` during a normal sunrise/sunset cycle, otherwise the polar condition.
    pub polar_condition: Option<PolarCondition>,
}

pub fn calc_sun_times(date: NaiveDate, lat: f64, lng: f64) -> SunTimes {
    let jd_noon = julian_day(date.year(), date.month(), date.day()) + 0.5;

    let (dec, eq_time) = solar_declination_and_eqtime(jd_noon);

    let solar_noon_mins = 720.0 - 4.0 * lng - eq_time;

    let solar_noon = minutes_to_utc(date, solar_noon_mins);

    let calc_event = |zenith: f64| -> Result<(String, String, f64), PolarCondition> {
        let ha = hour_angle(lat, dec, zenith)?;
        let sunrise_mins = solar_noon_mins - 4.0 * ha;
        let sunset_mins = solar_noon_mins + 4.0 * ha;
        let day_length_secs = 8.0 * ha * 60.0; // 4*ha minutes -> seconds
        Ok((
            minutes_to_utc(date, sunrise_mins),
            minutes_to_utc(date, sunset_mins),
            day_length_secs,
        ))
    };

    let official = calc_event(90.8333);
    let civil = calc_event(96.0);
    let nautical = calc_event(102.0);
    let astro = calc_event(108.0);

    // Extract polar condition from the official calculation (if any)
    let polar_condition = match &official {
        Err(pc) => Some(pc.clone()),
        Ok(_) => None,
    };

    SunTimes {
        sunrise: official.as_ref().ok().map(|e| e.0.clone()),
        sunset: official.as_ref().ok().map(|e| e.1.clone()),
        solar_noon,
        day_length: official.as_ref().ok().map(|e| e.2),
        civil_twilight_begin: civil.as_ref().ok().map(|e| e.0.clone()),
        civil_twilight_end: civil.as_ref().ok().map(|e| e.1.clone()),
        nautical_twilight_begin: nautical.as_ref().ok().map(|e| e.0.clone()),
        nautical_twilight_end: nautical.as_ref().ok().map(|e| e.1.clone()),
        astronomical_twilight_begin: astro.as_ref().ok().map(|e| e.0.clone()),
        astronomical_twilight_end: astro.as_ref().ok().map(|e| e.1.clone()),
        polar_condition,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pori_sun_times_are_in_the_expected_utc_hours() {
        let date = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        let times = calc_sun_times(date, 61.4850, 21.7970);

        assert!(
            times
                .sunrise
                .as_deref()
                .unwrap()
                .starts_with("2026-08-14T02:")
        );
        assert!(
            times
                .sunset
                .as_deref()
                .unwrap()
                .starts_with("2026-08-14T18:")
        );
        assert!(times.solar_noon.starts_with("2026-08-14T10:"));
        assert!(times.polar_condition.is_none());
    }

    #[test]
    fn utc_timestamp_keeps_day_rollover() {
        let date = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();

        assert_eq!(minutes_to_utc(date, -30.0), "2026-08-13T23:30:00+00:00");
        assert_eq!(minutes_to_utc(date, 1470.0), "2026-08-15T00:30:00+00:00");
    }
}
