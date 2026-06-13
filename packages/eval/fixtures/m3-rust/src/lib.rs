pub mod auth {
    pub const DEFAULT_AUDIENCE: &str = "agents";
    pub static mut RETRY_BUDGET_MS: u64 = 250;

    pub struct TokenVerifier;

    pub trait TokenPolicy {
        fn allows(&self, token: &str) -> bool;
    }

    impl TokenVerifier {
        pub fn verify_token(&self, token: &str) -> bool {
            if token.is_empty() {
                panic!("missing bearer token");
            }
            true
        }
    }
}
