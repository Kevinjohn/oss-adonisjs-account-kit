import type { Route } from '@tuyau/core/types'
import { client } from './client'

/** Compile-time proof that the application-owned reset route stays inferred by Tuyau. */
export async function checkResetRouteTypes(token: string) {
  const request = client.api.passwordResets.update({
    params: { token },
    body: {
      password: 'Replacement123!',
      passwordConfirmation: 'Replacement123!',
    },
  })

  client.api.passwordResets.update({
    params: { token },
    body: {
      // @ts-expect-error The reset route infers password as a string.
      password: 123,
      passwordConfirmation: 'Replacement123!',
    },
  })

  const [response, error] = await request.safe()
  const typedResponse: Route.Response<'password_resets.update'> | null = response
  const typedError: Route.Error<'password_resets.update'> | null = error

  if (error?.isValidationError()) {
    for (const validationError of error.response.errors) {
      const field: string = validationError.field
      const message: string = validationError.message
      void field
      void message
    }
  }

  return { typedResponse, typedError }
}
