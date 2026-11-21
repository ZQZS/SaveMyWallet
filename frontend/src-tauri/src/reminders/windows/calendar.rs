use super::super::{ReminderRecurrence, TIME};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};

impl ReminderRecurrence {
    fn matches(&self, day: NaiveDate) -> bool {
        match self {
            Self::Daily { .. } => true,
            Self::Weekly { weekday, .. } => {
                day.weekday().number_from_monday() == u32::from(*weekday)
            }
            Self::Monthly { day_of_month, .. } => day.day() == u32::from(*day_of_month),
        }
    }

    pub(super) fn trigger(&self, at: i64) -> Result<(String, i32), String> {
        const WEEKDAYS: [&str; 7] = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        ];
        let first = Local.timestamp_millis_opt(at).single().ok_or(TIME)?;
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
        };
        Ok((format!("<CalendarTrigger><StartBoundary>{start}</StartBoundary>{pattern}</CalendarTrigger>"), day.num_days_from_ce()))
    }

    pub(super) fn latest_slot<T: TimeZone>(
        &self,
        now: DateTime<T>,
        first: i32,
    ) -> Result<Option<i32>, String> {
        let clock = self.clock()?;
        let mut day = now.date_naive();
        let timezone = now.timezone();
        while day.num_days_from_ce() >= first {
            if self.matches(day)
                && timezone
                    .from_local_datetime(&day.and_time(clock))
                    .earliest()
                    .is_some_and(|occurrence| occurrence <= now)
            {
                return Ok(Some(day.num_days_from_ce()));
            }
            day = day.pred_opt().ok_or(TIME)?;
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn monthly_slot_skips_missing_dates_and_coalesces_time_away() {
        let rule = ReminderRecurrence::Monthly {
            time: "09:00".into(),
            day_of_month: 31,
        };
        let start = NaiveDate::from_ymd_opt(2025, 1, 31)
            .unwrap()
            .num_days_from_ce();
        let day = |month, day| {
            NaiveDate::from_ymd_opt(2026, month, day)
                .unwrap()
                .num_days_from_ce()
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
