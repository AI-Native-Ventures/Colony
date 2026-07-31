//! Colony company, initiative, task, and work-attribution contracts.

#[cfg(test)]
mod tests {
    use super::*;

    fn company_fixture() -> CompanyProfile {
        CompanyProfile {
            schema: "colony.company/v1".to_string(),
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: Some("Horizon Labs (Pty) Ltd".to_string()),
            website: Some("https://horizonlabs.co.za".to_string()),
            summary: "A digital services company.".to_string(),
            business_type: "digital-services".to_string(),
            services: vec![CompanyService {
                id: "web-development".to_string(),
                name: "Web Development".to_string(),
                description: "Premium website design and development.".to_string(),
            }],
            customer_segments: vec!["us-service-businesses".to_string()],
            cost_centres: vec![
                CostCentre {
                    id: "web-delivery".to_string(),
                    name: "Web Delivery".to_string(),
                    kind: CostCentreKind::Service,
                    service_id: Some("web-development".to_string()),
                },
                CostCentre {
                    id: "internal-product".to_string(),
                    name: "Internal Product".to_string(),
                    kind: CostCentreKind::Internal,
                    service_id: None,
                },
            ],
            source_report_event_id: Some("scan-event-1".to_string()),
            onboarding_status: CompanyOnboardingStatus::Approved,
            created_at: 1_785_400_000,
            updated_at: 1_785_400_100,
        }
    }

    fn team_fixtures() -> Vec<CompanyTeamRef> {
        vec![
            CompanyTeamRef {
                id: "web-team".to_string(),
                lead_persona_id: "cto".to_string(),
                persona_ids: vec![
                    "cto".to_string(),
                    "frontend-engineer".to_string(),
                    "backend-engineer".to_string(),
                ],
            },
            CompanyTeamRef {
                id: "marketing-team".to_string(),
                lead_persona_id: "marketing-lead".to_string(),
                persona_ids: vec![
                    "marketing-lead".to_string(),
                    "content-specialist".to_string(),
                ],
            },
        ]
    }

    fn initiative_fixture() -> Initiative {
        Initiative {
            schema: "colony.initiative/v1".to_string(),
            id: "tennant-premium-site".to_string(),
            company_id: "horizon-labs".to_string(),
            title: "Tennant Group premium website".to_string(),
            summary: "Rebuild the client's website and launch the campaign.".to_string(),
            status: InitiativeStatus::Active,
            owner_persona_id: "chief-of-staff".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            expected_cost_usd: Some(125.0),
            source_channel_id: "sales".to_string(),
            source_event_id: Some("message-1".to_string()),
            created_at: 1_785_400_200,
            updated_at: 1_785_400_300,
        }
    }

    fn task_fixtures() -> Vec<CompanyTask> {
        vec![
            CompanyTask {
                schema: "colony.task/v1".to_string(),
                id: "build-tennant-site".to_string(),
                company_id: "horizon-labs".to_string(),
                initiative_id: Some("tennant-premium-site".to_string()),
                title: "Build the Tennant Group website".to_string(),
                status: TaskStatus::InProgress,
                owning_team_id: "web-team".to_string(),
                assignee_persona_ids: vec![
                    "frontend-engineer".to_string(),
                    "content-specialist".to_string(),
                ],
                qa_persona_id: "cto".to_string(),
                cost_centre_id: "web-delivery".to_string(),
                commercial_purpose: CommercialPurpose::ClientDelivery,
                client_organization_id: Some("tennant-group".to_string()),
                source_channel_id: "sales".to_string(),
                source_event_id: Some("message-2".to_string()),
                implicit: false,
                created_at: 1_785_400_400,
                updated_at: 1_785_400_500,
            },
            CompanyTask {
                schema: "colony.task/v1".to_string(),
                id: "launch-tennant-campaign".to_string(),
                company_id: "horizon-labs".to_string(),
                initiative_id: Some("tennant-premium-site".to_string()),
                title: "Launch the Tennant Group campaign".to_string(),
                status: TaskStatus::Ready,
                owning_team_id: "marketing-team".to_string(),
                assignee_persona_ids: vec!["content-specialist".to_string()],
                qa_persona_id: "marketing-lead".to_string(),
                cost_centre_id: "web-delivery".to_string(),
                commercial_purpose: CommercialPurpose::ClientDelivery,
                client_organization_id: Some("tennant-group".to_string()),
                source_channel_id: "sales".to_string(),
                source_event_id: Some("message-3".to_string()),
                implicit: false,
                created_at: 1_785_400_600,
                updated_at: 1_785_400_700,
            },
        ]
    }

    #[test]
    fn exact_schema_json_round_trips() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let tasks = task_fixtures();

        let company_json = serde_json::to_string(&company).expect("serialize company");
        let initiative_json = serde_json::to_string(&initiative).expect("serialize initiative");
        let task_json = serde_json::to_string(&tasks[0]).expect("serialize task");
        let company_value: serde_json::Value =
            serde_json::from_str(&company_json).expect("company value");
        let initiative_value: serde_json::Value =
            serde_json::from_str(&initiative_json).expect("initiative value");
        let task_value: serde_json::Value = serde_json::from_str(&task_json).expect("task value");

        assert!(company_json.contains(r#""schema":"colony.company/v1""#));
        assert!(initiative_json.contains(r#""schema":"colony.initiative/v1""#));
        assert!(task_json.contains(r#""schema":"colony.task/v1""#));

        assert_eq!(company_value["tradingName"], "Horizon Labs");
        assert_eq!(company_value["legalName"], "Horizon Labs (Pty) Ltd");
        assert_eq!(company_value["businessType"], "digital-services");
        assert_eq!(
            company_value["customerSegments"][0],
            "us-service-businesses"
        );
        assert_eq!(company_value["costCentres"][0]["kind"], "service");
        assert_eq!(
            company_value["costCentres"][0]["serviceId"],
            "web-development"
        );
        assert_eq!(company_value["sourceReportEventId"], "scan-event-1");
        assert_eq!(company_value["onboardingStatus"], "approved");
        assert_eq!(company_value["createdAt"], 1_785_400_000_i64);
        assert_eq!(company_value["updatedAt"], 1_785_400_100_i64);
        assert!(company_value.get("trading_name").is_none());

        assert_eq!(initiative_value["companyId"], "horizon-labs");
        assert_eq!(initiative_value["status"], "active");
        assert_eq!(initiative_value["ownerPersonaId"], "chief-of-staff");
        assert_eq!(initiative_value["costCentreId"], "web-delivery");
        assert_eq!(initiative_value["commercialPurpose"], "clientDelivery");
        assert_eq!(initiative_value["clientOrganizationId"], "tennant-group");
        assert_eq!(initiative_value["expectedCostUsd"], 125.0);
        assert_eq!(initiative_value["sourceChannelId"], "sales");
        assert_eq!(initiative_value["sourceEventId"], "message-1");
        assert_eq!(initiative_value["createdAt"], 1_785_400_200_i64);
        assert_eq!(initiative_value["updatedAt"], 1_785_400_300_i64);
        assert!(initiative_value.get("company_id").is_none());

        assert_eq!(task_value["companyId"], "horizon-labs");
        assert_eq!(task_value["initiativeId"], "tennant-premium-site");
        assert_eq!(task_value["status"], "inProgress");
        assert_eq!(task_value["owningTeamId"], "web-team");
        assert_eq!(task_value["assigneePersonaIds"][0], "frontend-engineer");
        assert_eq!(task_value["qaPersonaId"], "cto");
        assert_eq!(task_value["costCentreId"], "web-delivery");
        assert_eq!(task_value["commercialPurpose"], "clientDelivery");
        assert_eq!(task_value["clientOrganizationId"], "tennant-group");
        assert_eq!(task_value["sourceChannelId"], "sales");
        assert_eq!(task_value["sourceEventId"], "message-2");
        assert_eq!(task_value["implicit"], false);
        assert_eq!(task_value["createdAt"], 1_785_400_400_i64);
        assert_eq!(task_value["updatedAt"], 1_785_400_500_i64);
        assert!(task_value.get("owning_team_id").is_none());

        assert_eq!(
            serde_json::from_str::<CompanyProfile>(&company_json).expect("parse company"),
            company
        );
        assert_eq!(
            serde_json::from_str::<Initiative>(&initiative_json).expect("parse initiative"),
            initiative
        );
        assert_eq!(
            serde_json::from_str::<CompanyTask>(&task_json).expect("parse task"),
            tasks[0]
        );
    }

    #[test]
    fn unknown_fields_fail_closed() {
        let mut company = serde_json::to_value(company_fixture()).expect("company json");
        company
            .as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(company).is_err());

        let mut initiative = serde_json::to_value(initiative_fixture()).expect("initiative json");
        initiative
            .as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<Initiative>(initiative).is_err());

        let mut task = serde_json::to_value(&task_fixtures()[0]).expect("task json");
        task.as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyTask>(task).is_err());
    }

    #[test]
    fn unknown_fields_in_nested_company_records_fail_closed() {
        let mut service = serde_json::to_value(company_fixture()).expect("company json");
        service["services"][0]
            .as_object_mut()
            .expect("service object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(service).is_err());

        let mut cost_centre = serde_json::to_value(company_fixture()).expect("company json");
        cost_centre["costCentres"][0]
            .as_object_mut()
            .expect("cost centre object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(cost_centre).is_err());
    }

    #[test]
    fn company_rejects_blank_ids_titles_and_duplicate_children() {
        assert!(validate_company(&company_fixture()).is_ok());

        let mut blank_id = company_fixture();
        blank_id.id = " ".to_string();
        assert!(validate_company(&blank_id).is_err());

        let mut blank_title = company_fixture();
        blank_title.trading_name = "".to_string();
        assert!(validate_company(&blank_title).is_err());

        let mut duplicate_service = company_fixture();
        duplicate_service
            .services
            .push(duplicate_service.services[0].clone());
        assert!(validate_company(&duplicate_service).is_err());

        let mut duplicate_cost_centre = company_fixture();
        duplicate_cost_centre
            .cost_centres
            .push(duplicate_cost_centre.cost_centres[0].clone());
        assert!(validate_company(&duplicate_cost_centre).is_err());
    }

    #[test]
    fn initiative_requires_a_company_cost_centre() {
        let company = company_fixture();
        let mut initiative = initiative_fixture();
        assert!(validate_initiative(&initiative, &company).is_ok());

        initiative.id = " ".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());

        initiative = initiative_fixture();
        initiative.title = "".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());

        initiative = initiative_fixture();
        initiative.cost_centre_id = "missing".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());
    }

    #[test]
    fn task_enforces_company_team_qa_and_unique_assignees() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let base = task_fixtures().remove(0);
        assert!(validate_task(&base, &company, Some(&initiative), &teams).is_ok());

        let mut blank_id = base.clone();
        blank_id.id = " ".to_string();
        assert!(validate_task(&blank_id, &company, Some(&initiative), &teams).is_err());

        let mut blank_title = base.clone();
        blank_title.title = "".to_string();
        assert!(validate_task(&blank_title, &company, Some(&initiative), &teams).is_err());

        let mut wrong_initiative = initiative.clone();
        wrong_initiative.company_id = "another-company".to_string();
        assert!(validate_task(&base, &company, Some(&wrong_initiative), &teams).is_err());

        let mut missing_team = base.clone();
        missing_team.owning_team_id = "missing-team".to_string();
        assert!(validate_task(&missing_team, &company, Some(&initiative), &teams).is_err());

        let mut qa_outside_team = base.clone();
        qa_outside_team.qa_persona_id = "marketing-lead".to_string();
        assert!(validate_task(&qa_outside_team, &company, Some(&initiative), &teams).is_err());

        let mut duplicate_assignee = base;
        duplicate_assignee
            .assignee_persona_ids
            .push("frontend-engineer".to_string());
        assert!(validate_task(&duplicate_assignee, &company, Some(&initiative), &teams).is_err());
    }

    #[test]
    fn specialist_from_another_team_does_not_change_task_ownership() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let task = task_fixtures().remove(0);

        assert_eq!(task.owning_team_id, "web-team");
        assert!(task
            .assignee_persona_ids
            .contains(&"content-specialist".to_string()));
        assert!(validate_task(&task, &company, Some(&initiative), &teams).is_ok());
    }

    #[test]
    fn commercial_purpose_maps_deterministically_to_cost_classification() {
        assert_eq!(
            classify_cost(CommercialPurpose::ClientDelivery, None),
            CostClassification::NeedsReview
        );
        assert_eq!(
            classify_cost(CommercialPurpose::ClientDelivery, Some("tennant-group")),
            CostClassification::Cogs
        );
        for purpose in [
            CommercialPurpose::Sales,
            CommercialPurpose::Marketing,
            CommercialPurpose::Administration,
            CommercialPurpose::InternalProduct,
        ] {
            assert_eq!(classify_cost(purpose, None), CostClassification::Opex);
        }
        assert_eq!(
            classify_cost(CommercialPurpose::Uncertain, Some("tennant-group")),
            CostClassification::NeedsReview
        );
    }
}
