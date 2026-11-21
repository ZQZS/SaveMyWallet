use super::*;
use crate::ledger::{ai_undo, review, BudgetInput};

fn capable_page(cursor: i64, records: Value) -> Value {
    let mut page = page(cursor, &records);
    page["supportsAiRevert"] = json!(true);
    page
}

fn token(db: &mut Connection) -> String {
    let preview = serde_json::to_value(ai_undo::preview(db).unwrap().unwrap()).unwrap();
    assert_eq!(preview["blocked"], false, "{preview}");
    preview["token"].as_str().unwrap().to_owned()
}

fn ai_budget(db: &Connection, salary: i64, monthly: Option<i64>) {
    let revision = review::revision(db).unwrap();
    ledger::budget(
        review::LedgerWrite::new(db, Some(&revision)),
        BudgetInput {
            month: "2027-01".into(),
            default_salary_cents: salary,
            warning_floor_cents: 0,
            override_salary_cents: monthly,
        },
    )
    .unwrap();
}

#[test]
fn a_budget_missing_from_the_server_can_be_withdrawn_or_compensated_without_sending_unchanged_settings(
) {
    for acknowledged in [false, true] {
        let mut db = database();
        let remote = capable_page(
            1,
            json!([{
                "kind":"platform","id":"p","version":"server","value":{"id":"p","name":"现金"}
            }]),
        );
        bind(&mut db, URL, &remote, "replace").unwrap();
        ai_budget(&db, 100, None);
        let original = token(&mut db);
        let mut source = Value::Null;
        if acknowledged {
            let op = next(&db).unwrap().unwrap();
            assert_eq!(op["changes"].as_array().unwrap().len(), 1);
            assert_eq!(op["changes"][0]["id"], "defaultSalaryCents");
            assert_eq!(op["changes"][0]["before"], Value::Null);
            source = op["operationId"].clone();
            ack(&mut db, &accepted(&op, 2)).unwrap();
        }
        ai_undo::apply(&mut db, &original).unwrap();
        assert_eq!(
            ledger::snapshot(&mut db)
                .unwrap()
                .settings
                .default_salary_cents,
            0
        );
        if acknowledged {
            let op = next(&db).unwrap().unwrap();
            assert_eq!(op["revertOperationIds"], json!([source]));
            assert_eq!(op["changes"].as_array().unwrap().len(), 1);
            assert_eq!(op["changes"][0]["before"], 100);
            assert_eq!(op["changes"][0]["after"], 0);
        } else {
            assert!(next(&db).unwrap().is_none());
        }
    }
}

#[test]
fn publish_preserves_an_offline_payment_and_the_manual_bill_and_void_that_followed_it() {
    let mut db = database();
    let platform = ledger::add_platform(&db, "我的平台").unwrap();
    let make_bill = |title: &str| {
        serde_json::from_value::<BillInput>(json!({
        "platformId":platform,"title":title,"month":"2027-01","amountCents":120,"kind":"single","installmentCount":1
    })).unwrap()
    };
    ledger::add_bill(&db, make_bill("AI 还款")).unwrap();
    let id = ledger::snapshot(&mut db).unwrap().entries[0].id.clone();
    let rev = review::revision(&db).unwrap();
    ledger::mark_payment(
        review::LedgerWrite::new(&db, Some(&rev)),
        std::slice::from_ref(&id),
        true,
    )
    .unwrap();
    ledger::set_entry_voided(&db, &id, true).unwrap();
    ledger::add_bill(&db, make_bill("独立手记")).unwrap();
    let receipt = token(&mut db);

    assert!(bind(&mut db, URL, &capable_page(1, json!([])), "publish").is_err());
    bind(&mut db, URL, &capable_page(0, json!([])), "publish").unwrap();
    let seed = next(&db).unwrap().unwrap();
    assert_eq!(seed["seed"], true);
    let rows = seed["changes"].as_array().unwrap();
    let ai_bill = rows.iter().find(|c| c["id"] == id).unwrap();
    assert_eq!(ai_bill["after"]["status"], "due");
    assert!(ai_bill["after"]["voided"].is_null());
    assert!(rows.iter().any(|c| c["after"]["title"] == "独立手记"));
    ack(&mut db, &accepted(&seed, 1)).unwrap();

    let ai = next(&db).unwrap().unwrap();
    assert_eq!(ai["seed"], false);
    assert!(ai["operationId"].as_str().unwrap().starts_with("ai."));
    assert_eq!(ai["changes"][0]["after"]["status"], "paid");
    assert!(ai["changes"][0]["after"]["voided"].is_null());
    ack(&mut db, &accepted(&ai, 2)).unwrap();
    let manual = next(&db).unwrap().unwrap();
    assert_eq!(manual["changes"][0]["after"]["voided"], true);
    ack(&mut db, &accepted(&manual, 3)).unwrap();
    assert_eq!(token(&mut db), receipt);

    ai_undo::apply(&mut db, &receipt).unwrap();
    let restored = ledger::snapshot(&mut db).unwrap();
    assert_eq!(restored.entries.len(), 2);
    let item = restored.entries.iter().find(|e| e.id == id).unwrap();
    assert!(item.voided);
    assert_eq!(item.status, "due");
    let compensation = next(&db).unwrap().unwrap();
    assert_eq!(
        compensation["revertOperationIds"],
        json!([ai["operationId"]])
    );
    assert_eq!(compensation["changes"].as_array().unwrap().len(), 1);
    assert_eq!(compensation["changes"][0]["after"]["voided"], true);
}

#[test]
fn first_publish_of_a_ledger_with_only_an_ai_platform_seeds_the_real_zero_budgets() {
    let mut db = database();
    db.execute("DELETE FROM platforms", []).unwrap();
    let rev = review::revision(&db).unwrap();
    ledger::add_platform(review::LedgerWrite::new(&db, Some(&rev)), "第一个平台").unwrap();
    let receipt = token(&mut db);
    bind(&mut db, URL, &capable_page(0, json!([])), "publish").unwrap();
    let seed = next(&db).unwrap().unwrap();
    let rows = seed["changes"].as_array().unwrap();
    assert_eq!(seed["seed"], true);
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|c| c["kind"] == "setting" && c["after"] == 0));
    ai_undo::apply(&mut db, &receipt).unwrap();
    assert!(ledger::snapshot(&mut db).unwrap().platforms.is_empty());
    assert_eq!(next(&db).unwrap().unwrap(), seed);
    ack(&mut db, &accepted(&seed, 1)).unwrap();
    assert!(next(&db).unwrap().is_none());
}

#[test]
fn first_publish_keeps_a_removed_salary_override_in_the_seed_until_the_ai_write() {
    let mut db = database();
    ai_budget(&db, 0, Some(0));
    ai_budget(&db, 0, None);
    let receipt = token(&mut db);
    bind(&mut db, URL, &capable_page(0, json!([])), "publish").unwrap();
    let seed = next(&db).unwrap().unwrap();
    assert!(seed["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["kind"] == "override" && c["after"] == 0));
    ack(&mut db, &accepted(&seed, 1)).unwrap();
    let original = next(&db).unwrap().unwrap();
    assert_eq!(original["changes"][0]["before"], 0);
    assert_eq!(original["changes"][0]["after"], Value::Null);
    ack(&mut db, &accepted(&original, 2)).unwrap();
    ai_undo::apply(&mut db, &receipt).unwrap();
    assert_eq!(
        ledger::snapshot(&mut db).unwrap().salary_overrides["2027-01"],
        0
    );
    let inverse = next(&db).unwrap().unwrap();
    assert_eq!(inverse["changes"][0]["after"], 0);
}
