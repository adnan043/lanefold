-- Member limits per plan: free 10, pro 50 (unchanged), team 500 (was 100; = SAFETY_CAPS.maxMembers, the most a plan may allow).
UPDATE "plan_limits" SET "max_members" = 10,  "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'free';
UPDATE "plan_limits" SET "max_members" = 50,  "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'pro';
UPDATE "plan_limits" SET "max_members" = 500, "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'team';
