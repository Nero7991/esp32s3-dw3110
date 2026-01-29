idf_component_register(SRCS "main.c"
                    INCLUDE_DIRS "."
                    REQUIRES libdeca decadriver
                    PRIV_REQUIRES driver)

# Allow setting TWR mode via cmake: -DTWR_MODE=initiator or -DTWR_MODE=responder
if(DEFINED TWR_MODE)
    if(TWR_MODE STREQUAL "initiator")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CONFIG_TWR_INITIATOR=1)
        message(STATUS "TWR Mode: INITIATOR (MAC16=0x0002)")
    elseif(TWR_MODE STREQUAL "responder")
        message(STATUS "TWR Mode: RESPONDER (MAC16=0x0001)")
    else()
        message(FATAL_ERROR "TWR_MODE must be 'initiator' or 'responder'")
    endif()
endif()
