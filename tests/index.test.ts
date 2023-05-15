import bodyParser from 'body-parser'
import express, {Express} from 'express'
import {Server} from 'node:http'
import {
    createLogEntry,
    GraphQLServer,
    GraphQLServerOptions,
    JsonLogger,
    LogEntry,
    LogEntryInput,
} from '@dreamit/graphql-server'
import {
    FETCH_ERROR,
    GRAPHQL_ERROR,
    INVALID_SCHEMA_ERROR,
    METHOD_NOT_ALLOWED_ERROR,
    MISSING_QUERY_PARAMETER_ERROR,
    SCHEMA_VALIDATION_ERROR,
    SYNTAX_ERROR,
    VALIDATION_ERROR,
    MetricsClient,
} from '@dreamit/graphql-server-base'
import fetch from 'cross-fetch'
import {Console} from 'node:console'

import {
    buildSchema,
    GraphQLError,
    GraphQLSchema,
    NoSchemaIntrospectionCustomRule
} from 'graphql'
import { PromMetricsClient } from '~/src'


class NoStacktraceJsonLogger extends JsonLogger {
    loggerConsole: Console = new Console(process.stdout, process.stderr, false)
    logMessage(logEntryInput: LogEntryInput): void {
        const {
            logMessage,
            loglevel,
            error,
            customErrorName,
            context
        } = logEntryInput

        const logEntry: LogEntry = createLogEntry({
            context,
            customErrorName,
            error,
            logMessage,
            loggerName: this.loggerName,
            loglevel,
            serviceName: this.serviceName,
        })
        logEntry.stacktrace = undefined
        this.loggerConsole.log(JSON.stringify(logEntry))
    }
}

const userSchema = buildSchema(`
  schema {
    query: Query
    mutation: Mutation
  }
  
  type Query {
    returnError: User 
    users: [User]
    user(id: String!): User
  }
  
  type Mutation {
    login(userName: String, password: String): LoginData
    logout: LogoutResult
  }
  
  type User {
    userId: String
    userName: String
  }
  
  type LoginData {
    jwt: String
  }
  
  type LogoutResult {
    result: String
  }
`)

const userSchemaResolvers= {
    returnError(): User {
        throw new GraphQLError('Something went wrong!', {})
    },
    users(): User[] {
        return [userOne, userTwo]
    },
    user(input: { id: string }): User {
        switch (input.id) {
        case '1': {
            return userOne
        }
        case '2': {
            return userTwo
        }
        default: {
            throw new GraphQLError(`User for userid=${input.id} was not found`, {})
        }
        }
    },
    logout(): LogoutResult {
        return {result: 'Goodbye!'}
    }
}

const GRAPHQL_SERVER_PORT = 3000
const LOGGER = new NoStacktraceJsonLogger('nostack-logger', 'myTestService', false)

function fetchResponse(body: BodyInit,
    method = 'POST',
    // eslint-disable-next-line unicorn/no-object-as-default-parameter
    headers: HeadersInit = {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Content-Type': 'application/json'
    }): Promise<Response> {
    return fetch(`http://localhost:${GRAPHQL_SERVER_PORT}/graphql`,
        {method: method, body: body, headers: headers})
}


interface User {
    userId: string
    userName: string
}

interface LogoutResult {
    result: string
}

const initialSchemaWithOnlyDescription = new GraphQLSchema({description:'initial'})

const userOne: User = {userId: '1', userName:'UserOne'}
const userTwo: User = {userId: '2', userName:'UserTwo'}

const usersQuery = 'query users{ users { userId userName } }'
const returnErrorQuery = 'query returnError{ returnError { userId } }'

let customGraphQLServer: GraphQLServer
let graphQLServer: Server
let metricsResponseBody: string

beforeAll(() => {
    graphQLServer = setupGraphQLServer().listen({port: GRAPHQL_SERVER_PORT})
    console.info(`Starting GraphQL server on port ${GRAPHQL_SERVER_PORT}`)
})

afterAll(() => {
    graphQLServer.close()
})

test('Should get correct metrics for DefaultMetricsClient', async() => {
    const metricsClient =  new PromMetricsClient()
    customGraphQLServer.setMetricsClient(metricsClient)
    await testInitialMetrics()
    await testInvalidSchemaMetrics(metricsClient)
    await testValidResponseMetrics()
    await testErrorResponseMetrics()
    await testEmptyContentResponseMetrics()
    await testFetchErrorResponseMetrics(metricsClient)
})

/**
 * Test:
 * When called before anything else availability should be 1 and the rest
 * of the counters and gauges should be 0
 */
async function testInitialMetrics(): Promise<void> {
    metricsResponseBody = await getMetricsResponse()
    expect(metricsResponseBody).toContain(
        'graphql_server_availability 1'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 0'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
}

/**
 * Test:
 * When schema is invalid, availability should be 0. As only metrics endpoint
 * is being called, request_throughput should stay at 0,
 * SchemaValidationError should increase to 1 and GraphQLError counter should stay at 0
 */
async function testInvalidSchemaMetrics(metricsClient: MetricsClient): Promise<void> {
    customGraphQLServer.setOptions({
        schema: initialSchemaWithOnlyDescription,
        rootValue: userSchemaResolvers,
        logger: LOGGER,
        metricsClient: metricsClient,
        shouldUpdateSchemaFunction: () => true
    })
    metricsResponseBody = await getMetricsResponse()


    expect(metricsResponseBody).toContain(
        'graphql_server_availability 0'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 0'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
    
    customGraphQLServer.setOptions(getInitialGraphQLServerOptions(metricsClient))
}

/**
 * Test:
 * With working schema, availability should be 1.
 * When sending request with valid data response,
 * request_throughput should increase to 1.
 */
async function testValidResponseMetrics(): Promise<void> {

    await fetchResponse(`{"query":"${usersQuery}"}`)
    metricsResponseBody = await getMetricsResponse()

    expect(metricsResponseBody).toContain(
        'graphql_server_availability 1'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 1'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
}

/**
 * Test:
 * When sending request that returns GraphQL error,
 * GraphQLError counter and request throughput should increase by 1
 */
async function testErrorResponseMetrics(): Promise<void> {
    await fetchResponse(`{"query":"${returnErrorQuery}"}`)
    metricsResponseBody = await getMetricsResponse()

    expect(metricsResponseBody).toContain(
        'graphql_server_availability 1'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 2'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
}

/**
 * Test:
 * When sending request with empty content type GraphQL error,
 * GraphQLError counter and request throughput should increase by 1
 */
async function testEmptyContentResponseMetrics(): Promise<void> {
    await fetchResponse('{"query":"unknown"}', 'POST', {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Content-Type': ''
    })
    metricsResponseBody = await getMetricsResponse()

    expect(metricsResponseBody).toContain(
        'graphql_server_availability 1'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 3'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 2`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
}

/**
 * Test:
 * When forcing a FetchError in execute function,
 * FetchError counter and request throughput should increase by 1
 */
async function testFetchErrorResponseMetrics(metricsClient: MetricsClient): Promise<void> {

    customGraphQLServer.setOptions({
        schema: userSchema,
        rootValue: userSchemaResolvers,
        logger: LOGGER,
        metricsClient: metricsClient,
        executeFunction: () => {
            throw new GraphQLError('FetchError: ' +
                'An error occurred while connecting to following endpoint', {})
        }
    })

    await fetchResponse(`{"query":"${usersQuery}"}`)
    metricsResponseBody = await getMetricsResponse()
    
    expect(metricsResponseBody).toContain(
        'graphql_server_availability 1'
    )
    expect(metricsResponseBody).toContain(
        'graphql_server_request_throughput 4'
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${GRAPHQL_ERROR}"} 2`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SCHEMA_VALIDATION_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${FETCH_ERROR}"} 1`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${METHOD_NOT_ALLOWED_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${INVALID_SCHEMA_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${MISSING_QUERY_PARAMETER_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${VALIDATION_ERROR}"} 0`
    )
    expect(metricsResponseBody).toContain(
        `graphql_server_errors{errorClass="${SYNTAX_ERROR}"} 0`
    )
    customGraphQLServer.setOptions(getInitialGraphQLServerOptions(metricsClient))
}

function setupGraphQLServer(): Express {
    const graphQLServerExpress = express()
    customGraphQLServer = new GraphQLServer(getInitialGraphQLServerOptions(new PromMetricsClient()))
    graphQLServerExpress.use(bodyParser.json())
    graphQLServerExpress.all('/graphql', (request, response) => {
        return customGraphQLServer.handleRequest(request, response)
    })
    graphQLServerExpress.get('/metrics', async(_request, response) => {
        return response.contentType(customGraphQLServer.getMetricsContentType())
        .send(await customGraphQLServer.getMetrics())
    })
    return graphQLServerExpress
}

function getInitialGraphQLServerOptions(metricsClient: MetricsClient): GraphQLServerOptions {
    return {
        schema: userSchema,
        rootValue: userSchemaResolvers,
        logger: LOGGER,
        customValidationRules: [NoSchemaIntrospectionCustomRule],
        metricsClient: metricsClient
    }
}

async function getMetricsResponse(): Promise<string> {
    const metricsResponse = await fetch(`http://localhost:${GRAPHQL_SERVER_PORT}/metrics`)
    return await metricsResponse.text()
}
