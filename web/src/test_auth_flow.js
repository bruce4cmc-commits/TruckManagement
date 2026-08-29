import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

const supabase = createClient(supabaseUrl, supabaseKey)

const testAccounts = [
  { type: 'DRIVER', id: 'D001', truck_id: 'T001', email: 'd001@truckmgmt.com', password: 'Password123!' },
  { type: 'DRIVER', id: 'D002', truck_id: 'T002', email: 'd002@truckmgmt.com', password: 'Password123!' },
  { type: 'MANAGEMENT', id: 'U001', login_name: 'logistics01', email: 'logistics01@truckmgmt.com', password: 'Password123!' },
  { type: 'MANAGEMENT', id: 'U002', login_name: 'supervisor01', email: 'supervisor01@truckmgmt.com', password: 'Password123!' },
]

async function testAuth() {
  console.log('=== TESTING AUTH CREATION & BINDING ===')
  
  for (const acc of testAccounts) {
    console.log(`Checking ${acc.email}...`)
    
    // Try login
    let { data, error } = await supabase.auth.signInWithPassword({
      email: acc.email,
      password: acc.password
    })

    if (error) {
      console.log(`Login failed (${error.message}). Trying signUp...`)
      const signUpRes = await supabase.auth.signUp({
        email: acc.email,
        password: acc.password,
        options: {
          data: {
            app_role: acc.type,
            ref_id: acc.id
          }
        }
      })
      if (signUpRes.error) {
        console.error(`SignUp error for ${acc.email}:`, signUpRes.error.message)
      } else {
        console.log(`Signed up ${acc.email}, User ID:`, signUpRes.data.user?.id)
      }
    } else {
      console.log(`Logged in as ${acc.email}, User ID:`, data.user?.id)
    }
  }
}

testAuth()
