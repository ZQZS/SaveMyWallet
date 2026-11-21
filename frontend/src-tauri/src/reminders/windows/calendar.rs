use super::super::{parse_clock, ReminderRecurrence, TIME};
use chrono::{
    DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat,
    TimeZone, Timelike, Utc,
};

pub(super) struct Window {
    start: NaiveTime,
    span: u32,
    seed: u32,
}

impl Window {
    // The TS, Rust and Android schedulers sample the same minute for the window's starting date.
    fn bounds(&self, day: NaiveDate) -> (NaiveDateTime, NaiveDateTime) {
        let start = day.and_time(self.start);
        (start, start + Duration::minutes(i64::from(self.span) + 1))
    }

    fn occurrence<T: TimeZone>(&self, day: NaiveDate, zone: &T) -> Option<DateTime<T>> {
        let ymd = day.year() as u32 * 10000 + day.month() * 100 + day.day();
        let mut x = self.seed ^ ymd;
        x = (x ^ (x >> 16)).wrapping_mul(0x045d9f3b);
        x = (x ^ (x >> 16)).wrapping_mul(0x045d9f3b);
        let minutes = (x ^ (x >> 16)) % (self.span + 1);
        let wall = day.and_time(self.start) + Duration::minutes(i64::from(minutes));
        zone.from_local_datetime(&wall).earliest()
    }

    // The end minute is inclusive. It may belong to the morning after the window opened.
    pub(super) fn due<T: TimeZone>(&self, now: &DateTime<T>, first: i64) -> Option<i64> {
        let today = now.date_naive();
        [Some(today), today.pred_opt()]
            .into_iter()
            .flatten()
            .find_map(|day| {
                let slot = i64::from(day.num_days_from_ce());
                let (start, end) = self.bounds(day);
                (slot >= first
                    && now.naive_local() >= start
                    && now.naive_local() < end
                    && self
                        .occurrence(day, &now.timezone())
                        .as_ref()
                        .is_some_and(|at| at <= now))
                .then_some(slot)
            })
    }

    pub(super) fn next<T: TimeZone>(
        &self,
        now: &DateTime<T>,
        first: i64,
    ) -> Result<DateTime<T>, String> {
        let mut day = now.date_naive().pred_opt().ok_or(TIME)?;
        if i64::from(day.num_days_from_ce()) < first {
            day = i32::try_from(first)
                .ok()
                .and_then(NaiveDate::from_num_days_from_ce_opt)
                .ok_or(TIME)?;
        }
        loop {
            if let Some(at) = self.occurrence(day, &now.timezone()) {
                if &at > now {
                    return Ok(at);
                }
            }
            day = day.succ_opt().ok_or(TIME)?;
        }
    }
}

fn daily_trigger(day_time: NaiveDateTime) -> String {
    let start = day_time.format("%Y-%m-%dT%H:%M:%S");
    format!("<CalendarTrigger><StartBoundary>{start}</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>")
}

impl ReminderRecurrence {
    pub(super) fn window(&self) -> Result<Option<Window>, String> {
        let Self::RandomWindow {
            start_time,
            end_time,
            seed,
        } = self
        else {
            return Ok(None);
        };
        let start = parse_clock(start_time)?;
        let start_minutes = start.num_seconds_from_midnight() / 60;
        let end_minutes = parse_clock(end_time)?.num_seconds_from_midnight() / 60;
        let span = (end_minutes + 1440 - start_minutes) % 1440;
        if span == 0 {
            return Err(TIME.into());
        }
        Ok(Some(Window {
            start,
            span,
            seed: *seed,
        }))
    }

    fn matches(&self, day: NaiveDate) -> bool {
        match self {
            Self::Daily { .. } => true,
            Self::Weekly { weekday, .. } => {
                day.weekday().number_from_monday() == u32::from(*weekday)
            }
            Self::Monthly { day_of_month, .. } => day.day() == u32::from(*day_of_month),
            Self::Interval { .. } | Self::RandomWindow { .. } => false,
        }
    }

    pub(super) fn trigger(&self, at: i64) -> Result<(String, i64), String> {
        const WEEKDAYS: [&str; 7] = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        ];
        self.validate()?;
        let first = Local.timestamp_millis_opt(at).single().ok_or(TIME)?;
        if !(1..=9999).contains(&first.year()) {
            return Err(TIME.into());
        }
        if let Self::Interval { minutes, anchor_at } = self {
            let period = i64::from(*minutes) * 60000;
            if at < *anchor_at || (at - anchor_at) % period != 0 {
                return Err(TIME.into());
            }
            let start = first
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true);
            let xml = format!("<TimeTrigger><StartBoundary>{start}</StartBoundary><Repetition><Interval>PT{minutes}M</Interval></Repetition></TimeTrigger>");
            return Ok((xml, (at - anchor_at) / period));
        }
        if let Some(window) = self.window()? {
            let slot = window.due(&first, i64::MIN).ok_or(TIME)?;
            let day = NaiveDate::from_num_days_from_ce_opt(slot as i32).ok_or(TIME)?;
            if window.occurrence(day, &Local).as_ref() != Some(&first) {
                return Err(TIME.into());
            }
            return Ok((window_trigger(first), slot));
        }
        let day = first.date_naive();
        if !self.matches(day) || self.clock()? != first.time() {
            return Err(TIME.into());
        }
        // A boundary without a UTC offset follows the device's wall clock when its time zone changes.
        let start = first.format("%Y-%m-%dT%H:%M:%S");
        let pattern = match self {
            Self::Daily { .. } => "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>".into(),
            Self::Weekly { weekday, .. } => {
                let name = WEEKDAYS[usize::from(*weekday) - 1];
                format!("<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><{name}/></DaysOfWeek></ScheduleByWeek>")
            }
            Self::Monthly { day_of_month, .. } => format!("<ScheduleByMonth><DaysOfMonth><Day>{day_of_month}</Day></DaysOfMonth><Months><January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/></Months></ScheduleByMonth>"),
            _ => return Err(TIME.into()),
        };
        Ok((format!("<CalendarTrigger><StartBoundary>{start}</StartBoundary>{pattern}</CalendarTrigger>"), i64::from(day.num_days_from_ce())))
    }

    pub(super) fn latest_slot<T: TimeZone>(
        &self,
        now: DateTime<T>,
        first: i64,
    ) -> Result<Option<i64>, String> {
        if let Self::Interval { minutes, anchor_at } = self {
            self.validate()?;
            let at = now.timestamp_millis();
            if at < *anchor_at {
                return Ok(None);
            }
            let slot = (at - anchor_at) / (i64::from(*minutes) * 60000);
            return Ok((slot >= first).then_some(slot));
        }
        if let Some(window) = self.window()? {
            return Ok(window.due(&now, first));
        }
        let clock = self.clock()?;
        let mut day = now.date_naive();
        let timezone = now.timezone();
        while i64::from(day.num_days_from_ce()) >= first {
            if self.matches(day)
                && timezone
                    .from_local_datetime(&day.and_time(clock))
                    .earliest()
                    .is_some_and(|occurrence| occurrence <= now)
            {
                return Ok(Some(i64::from(day.num_days_from_ce())));
            }
            day = day.pred_opt().ok_or(TIME)?;
        }
        Ok(None)
    }
}

pub(super) fn window_trigger(at: DateTime<Local>) -> String {
    // A daily trigger also wakes the helper again if a previous run failed to advance it.
    // Keep a floating local time for travel. In an autumn overlap also register the exact
    // earlier UTC instant; both triggers share the same transactional delivery claim.
    let mut trigger = daily_trigger(at.naive_local());
    if matches!(
        Local.from_local_datetime(&at.naive_local()),
        chrono::LocalResult::Ambiguous(..)
    ) {
        let start = at
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        trigger.push_str(&format!(
            "<TimeTrigger><StartBoundary>{start}</StartBoundary></TimeTrigger>"
        ));
    }
    trigger
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn utc_interval_wakes_at_the_same_instant_after_travel_and_skips_elapsed_ticks() {
        let first = Utc.with_ymd_and_hms(2026, 11, 22, 12, 3, 28).unwrap();
        let at = first.timestamp_millis();
        let rule = ReminderRecurrence::Interval {
            minutes: 20,
            anchor_at: at,
        };
        let (xml, initial) = rule.trigger(at).unwrap();
        assert!(xml.contains("2026-11-22T12:03:28Z</StartBoundary><Repetition><Interval>PT20M"));
        assert!(rule.trigger(at + 60000).is_err());
        assert_eq!(rule.trigger(at + 1200000).unwrap().1, 1);
        let east = chrono::FixedOffset::east_opt(9 * 3600).unwrap();
        assert_eq!(
            rule.latest_slot(
                (first - Duration::milliseconds(1)).with_timezone(&east),
                initial
            )
            .unwrap(),
            None
        );
        assert_eq!(
            rule.latest_slot(
                (first + Duration::minutes(43)).with_timezone(&east),
                initial
            )
            .unwrap(),
            Some(2)
        );
        for (minutes, valid) in [
            (0, false),
            (1, false),
            (10, true),
            (11, false),
            (44640, true),
            (44650, false),
        ] {
            assert_eq!(
                ReminderRecurrence::Interval {
                    minutes,
                    anchor_at: at
                }
                .validate()
                .is_ok(),
                valid
            );
        }
        assert!(ReminderRecurrence::Interval {
            minutes: 20,
            anchor_at: at + 1
        }
        .validate()
        .is_err());
    }

    #[test]
    fn seeded_minutes_match_other_clients_and_cross_midnight_without_two_claims() {
        let rest = ReminderRecurrence::RandomWindow {
            start_time: "23:00".into(),
            end_time: "01:00".into(),
            seed: 42,
        };
        let lunch = ReminderRecurrence::RandomWindow {
            start_time: "11:30".into(),
            end_time: "13:00".into(),
            seed: 42,
        };
        let noon = |day, h, m| Utc.with_ymd_and_hms(2026, 11, day, h, m, 0).unwrap();
        let date = noon(22, 0, 0).date_naive();
        let start = i64::from(date.num_days_from_ce());
        let window = rest.window().unwrap().unwrap();
        assert_eq!(
            window.next(&noon(22, 13, 5), start).unwrap(),
            noon(22, 23, 55)
        );
        assert_eq!(
            window.next(&noon(22, 23, 55), start).unwrap(),
            noon(24, 0, 44)
        );
        assert_eq!(window.due(&noon(23, 1, 0), start), Some(start));
        assert_eq!(window.due(&noon(23, 1, 1), start), None);
        assert_eq!(window.due(&noon(24, 0, 43), start), None);
        assert_eq!(window.due(&noon(24, 0, 44), start), Some(start + 1));
        let lunch = lunch.window().unwrap().unwrap();
        assert_eq!(
            lunch.next(&noon(22, 0, 0), start).unwrap(),
            noon(22, 11, 56)
        );
        assert_eq!(
            lunch.due(&(noon(22, 13, 1) - Duration::milliseconds(1)), start),
            Some(start)
        );
        assert_eq!(lunch.due(&noon(22, 23, 0), start), None);
    }

    #[test]
    fn monthly_slot_skips_missing_dates_and_coalesces_time_away() {
        let rule = ReminderRecurrence::Monthly {
            time: "09:00".into(),
            day_of_month: 31,
        };
        let start = NaiveDate::from_ymd_opt(2025, 1, 31)
            .unwrap()
            .num_days_from_ce() as i64;
        let day = |month, day| {
            NaiveDate::from_ymd_opt(2026, month, day)
                .unwrap()
                .num_days_from_ce() as i64
        };
        assert_eq!(
            rule.latest_slot(Utc.with_ymd_and_hms(2026, 3, 31, 8, 59, 59).unwrap(), start)
                .unwrap(),
            Some(day(1, 31))
        );
        assert_eq!(
            rule.latest_slot(Utc.with_ymd_and_hms(2026, 3, 31, 9, 0, 0).unwrap(), start)
                .unwrap(),
            Some(day(3, 31))
        );
        assert_eq!(
            rule.latest_slot(
                Utc.with_ymd_and_hms(2026, 2, 1, 12, 0, 0).unwrap(),
                day(3, 31)
            )
            .unwrap(),
            None
        );
    }
}
