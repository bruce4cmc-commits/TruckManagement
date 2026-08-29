import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

const supabase = createClient(supabaseUrl, supabaseKey)

const testAccounts = [
  { type: 'driver', id: 'D001', truck_id: 'T001', truck_no: '車01', email: 'driver_t001@example.com', password: 'Password123!' },
  { type: 'driver', id: 'D002', truck_id: 'T002', truck_no: '車02', email: 'driver_t002@example.com', password: 'Password123!' },
  { type: 'user', id: 'U001', login_name: 'logistics01', email: 'logistics01@example.com', password: 'Password123!' },
  { type: 'user', id: 'U002', login_name: 'supervisor01', email: 'supervisor01@example.com', password: 'Password123!' },
]

async function setupAuth() {
  console.log('=== SETTING UP AUTH USERS ===')
  const results = []

  for (const acc of testAccounts) {
    console.log(`Processing ${acc.email}...`)
    
    // Try sign in
    let { data, error } = await supabase.auth.signInWithPassword({
      email: acc.email,
      password: acc.password
    })

    if (!error && data.user) {
      console.log(`User ${acc.email} exists with UID:`, data.user.id)
      results.push({ ...acc, auth_user_id: data.user.id })
      await supabase.auth.signOut()
    } else {
      console.log(`Sign in failed (${error?.message}), attempting signUp...`)
      const res = await supabase.auth.signUp({
        email: acc.email,
        password: acc.password
      })

      if (res.error) {
        console.error(`SignUp failed for ${acc.email}:`, res.error.message)
      } else if (res.data.user) {
        console.log(`Successfully created ${acc.email} with UID:`, res.data.user.id)
        results.push({ ...acc, auth_user_id: res.data.user.id })
      }
    }
  }

  console.log('=== FINAL RESULTS ===')
  console.log(JSON.stringify(results, null, 2))
}

setupAuth()
